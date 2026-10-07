import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  type Agent,
  type Answer,
  activeMembers,
  Decision,
  type DecisionLink,
  type Directory,
  noteHead as keepHead,
  open,
  ProtocolError,
  parseWith,
  SealedItem,
  type SessionLink,
  type Settled,
  seal,
  verifyDirectory,
  type Waiting,
  withheldBy,
} from "@starbridge/protocol";
import { ApiError } from "./api";
import { claudeSession } from "./claude";
import { type CodexSession, codexAsker, codexSession } from "./codex";
import type { State } from "./config";
import {
  type Ctx,
  devices,
  iso,
  machineKind,
  parseDuration,
  refreshDirectory,
  type Session,
  session,
  signedHead,
  UsageError,
} from "./context";
import { fitPicture, loadPicture, type Picture } from "./images";
import { OPENCODE_ANSWERS, OPENCODE_SESSION, OPENCODE_TITLE } from "./opencode";
import { acceptPermissionAnswer } from "./permissions";
import { PI_ANSWERS, piSessionTitle } from "./pi";

export interface AskInput {
  question?: string;
  context?: string;
  options?: string[];
  recommended?: string;
  /** Post it already `waiting`: the agent has nothing else to do. */
  waiting?: boolean;
  /** The coding agent asking; default: Claude Code, Codex, Pi or opencode when it runs the command. */
  agent?: Agent;
  /** Where a Codex session runs: its `CODEX_HOME` and the `codex` that answers reach it with. */
  codex?: CodexSession;
  /** A Pi or opencode session whose Starbridge extension or plugin submits answers into it. */
  extensionAnswers?: boolean;
  /** A `claude -p` session: the mod runs only in interactive ones, so nothing submits answers. */
  headless?: boolean;
  /** For a hook that waits for the answer itself (`hook question`): no session gets it. */
  held?: boolean;
  project?: string;
  session?: string;
  sessionTitle?: string;
  sessionLinks?: SessionLink[];
  /** Image files, PNG or JPEG, with what each shows when known. */
  images?: (string | { path: string; alt?: string })[];
  /** Pages to open, such as a claude.ai artifact. */
  links?: (string | DecisionLink)[];
  /** The page the owner answers on instead of Starbridge; the decision then has no options. */
  answerIn?: string | DecisionLink;
}

/** What the server stores at most for one decision, boxes and blobs together (PROTOCOL.md, Limits). */
export const ITEM_BYTES = 2 * 1024 * 1024;

/** One image's file at most: its blob is then the 512 KB of base64url `BLOB_MAX` allows. */
const IMAGE_BYTES = 384 * 1024;

/** Exit code when nobody answered before `--timeout`. */
export const EXIT_TIMEOUT = 2;
/** `wait <id>`'s exit code when the owner snoozed the decision (#571): no answer before then. */
export const EXIT_SNOOZED = 3;
/** Exit code on Ctrl-C, as a shell reports SIGINT. */
export const EXIT_INTERRUPTED = 130;
/** The server holds a long-poll at most this long (PROTOCOL.md). */
const MAX_POLL_SECONDS = 300;
/** Pause before retrying after a network or server error. */
const RETRY_MS = 5_000;

/**
 * Fills in which session asks, from the asking process's environment and directory. Unless the
 * flags give them, the title and links come from Claude Code's record of that session, so an
 * agent never has to look them up. The CLI resolves this before it hands a decision to the
 * local agent, which runs elsewhere.
 */
export function resolveSource(
  input: AskInput,
  env: Ctx["env"],
  cwd: string,
): AskInput & { project: string; session: string; sessionLinks: SessionLink[] } {
  const agent = agentOf(input, env).agent;
  // The id of the agent that asks: an agent started from another one's shell inherits its id too.
  const session =
    input.session ??
    (agent === "codex"
      ? codexAsker(env)
      : agent === "pi"
        ? env.PI_SESSION_ID
        : agent === "opencode"
          ? env[OPENCODE_SESSION]
          : env.CLAUDE_CODE_SESSION_ID) ??
    "";
  const codex = agent === "codex" ? (input.codex ?? codexSession(env)) : undefined;
  const answersEnv = agent === "pi" ? PI_ANSWERS : agent === "opencode" ? OPENCODE_ANSWERS : "";
  const extensionAnswers =
    !!answersEnv && (input.extensionAnswers ?? (!!session && env[answersEnv] === session));
  const headless =
    agent === "claude-code" && (input.headless ?? env.CLAUDE_CODE_SESSION_ATTENDED === "0");
  const claude =
    session &&
    agent !== "codex" &&
    agent !== "pi" &&
    agent !== "opencode" &&
    (input.sessionTitle === undefined || input.sessionLinks === undefined)
      ? claudeSession(env, session)
      : undefined;
  const title =
    input.sessionTitle ??
    (agent === "pi"
      ? piSessionTitle(env)
      : agent === "opencode"
        ? env[OPENCODE_TITLE]?.slice(0, 200) || undefined
        : undefined) ??
    claude?.title;
  const at = (path: string) => resolve(cwd, path);
  return {
    ...input,
    ...(agent ? { agent } : {}),
    ...(codex ? { codex } : {}),
    ...(extensionAnswers ? { extensionAnswers } : {}),
    ...(headless ? { headless } : {}),
    project: input.project ?? basename(cwd),
    session,
    ...(title !== undefined ? { sessionTitle: title } : {}),
    sessionLinks: input.sessionLinks ?? claude?.links ?? [],
    // Image paths are the asking directory's; the agent reads them from its own.
    ...(input.images
      ? {
          images: input.images.map((i) =>
            typeof i === "string" ? at(i) : { ...i, path: at(i.path) },
          ),
        }
      : {}),
  };
}

function sourceFor(input: AskInput, ctx: Ctx, machine: string): Decision["source"] {
  const r = resolveSource(input, ctx.env, process.cwd());
  return {
    machine,
    ...machineKind(ctx),
    project: r.project,
    session: r.session,
    ...(r.sessionTitle ? { sessionTitle: r.sessionTitle } : {}),
    ...(r.sessionLinks.length > 0 ? { links: r.sessionLinks } : {}),
  };
}

export function buildDecision(input: AskInput, ctx: Ctx, machine: string, to: string[]): Decision {
  if (!input.question) throw new UsageError("ask needs --question");
  const options = input.options ?? [];
  const link = (l: string | DecisionLink) => (typeof l === "string" ? { url: l } : l);
  const links = (input.links ?? []).map(link);
  if (input.answerIn !== undefined && options.length > 0)
    throw new UsageError(
      "--answer-in takes no --option: the owner answers on that page, never in two places",
    );
  const decision = {
    v: 1 as const,
    id: `d_${randomBytes(12).toString("base64url")}`,
    to,
    createdAt: iso(ctx.now()),
    question: input.question,
    context: input.context ?? "",
    options,
    ...(options.length > 0 ? { recommended: input.recommended ?? options[0] } : {}),
    ...agentOf(input, ctx.env),
    source: sourceFor(input, ctx, machine),
    ...(links.length > 0 ? { links } : {}),
    ...(input.answerIn !== undefined ? { answerIn: link(input.answerIn) } : {}),
    ...(options.length > 0 ? { replies: true as const } : {}),
    ...(input.answerIn !== undefined ? { done: true as const } : {}),
  };
  return checked(decision);
}

/**
 * `--agent`, else the agent that runs this command: Claude Code sets CLAUDECODE=1, Codex gives
 * every command its session id in CODEX_THREAD_ID, Pi in PI_SESSION_ID, and the Starbridge
 * opencode plugin STARBRIDGE_OPENCODE_SESSION (clearing the others it inherited). An agent
 * passes these on to the agents it starts, so two can be set. Codex, Pi and opencode run
 * commands without a terminal, so a Claude Code they started runs as `claude -p`
 * (CLAUDE_CODE_SESSION_ATTENDED=0); otherwise Codex, Pi or opencode was started from a Claude
 * Code session (a `codex exec` review, a script) and asks.
 */
function agentOf(input: AskInput, env: Ctx["env"]): { agent?: Agent } {
  if (input.agent !== undefined) return { agent: input.agent };
  const claude = env.CLAUDECODE === "1";
  if (claude && env.CLAUDE_CODE_SESSION_ATTENDED === "0") return { agent: "claude-code" };
  if (env.CODEX_THREAD_ID) return { agent: "codex" };
  if (env.PI_SESSION_ID) return { agent: "pi" };
  if (env[OPENCODE_SESSION]) return { agent: "opencode" };
  return claude ? { agent: "claude-code" } : {};
}

function checked(decision: unknown): Decision {
  try {
    return parseWith(Decision, decision);
  } catch (e) {
    throw e instanceof ProtocolError ? new UsageError(`bad decision: ${e.message}`) : e;
  }
}

/** The most boxes an item holds, so the most devices a decision is ever re-sealed to. */
const MAX_BOXES = 64;

/**
 * What the item weighs once re-sealed to as many devices as it can ever reach: its blobs once,
 * its largest box once per device. A re-seal sends no blobs, but the server counts the ones it
 * keeps, so a decision that fits only its first devices could never reach a new one (#720).
 */
const itemBytes = (item: SealedItem) =>
  Math.max(MAX_BOXES, item.boxes.length) * Math.max(0, ...item.boxes.map((b) => b.box.length)) +
  (item.blobs ?? []).reduce((n, b) => n + b.length, 0);

/**
 * Signs and seals the decision with its pictures, scaled down until its boxes and blobs fit
 * ITEM_BYTES for every device it may be re-sealed to. Each picture is one blob, base64url,
 * whatever the number of devices (#685).
 */
function sealWithPictures(
  base: Decision,
  pictures: Picture[],
  signer: { id: string; signKey: Uint8Array },
  to: ReturnType<typeof devices>,
): { decision: Decision; item: SealedItem } {
  const sealed = (d: Decision) => seal("decision", d, signer, to);
  if (pictures.length === 0) return { decision: base, item: sealed(base) };
  if (pictures.length > 4) throw new UsageError("--image: at most 4 images");
  let share = Math.min(
    IMAGE_BYTES,
    Math.floor(((ITEM_BYTES - itemBytes(sealed(base))) * 3) / 4 / pictures.length),
  );
  for (let tries = 0; tries < 5; tries++) {
    if (share < 1024) break;
    const fitted = pictures.map((p) => fitPicture(p, share));
    const decision = checked({ ...base, images: fitted.map((f) => f.image) });
    const item = { ...sealed(decision), blobs: fitted.map((f) => f.blob) };
    const size = itemBytes(item);
    if (size <= ITEM_BYTES) return { decision, item };
    share = Math.floor(share * (ITEM_BYTES / size) * 0.95);
  }
  throw new UsageError(
    "the images do not fit in one decision: attach fewer images, or shorten the context",
  );
}

/**
 * Seals the decision to every active device, posts it and records it in the state, so its
 * answer reaches the session that asked. Returns the decision.
 */
export async function postDecision(ctx: Ctx, s: Session, input: AskInput): Promise<Decision> {
  const dir = await refreshDirectory(ctx, s);
  const pictures = (input.images ?? []).map((i) =>
    typeof i === "string" ? loadPicture(i) : loadPicture(i.path, i.alt),
  );
  const to = devices(dir);
  const base = {
    ...buildDecision(
      input,
      ctx,
      s.machine.name,
      to.map((d) => d.id),
    ),
    dir: signedHead(ctx, dir),
  };
  const { decision, item } = sealWithPictures(
    base,
    pictures,
    { id: s.machine.id, signKey: s.keys.sign.privateKey },
    to,
  );
  // A wait for this decision starts at the cursor known now, so it never misses its answer.
  const cursor = ctx.store.state().cursor;
  // Asked already waiting, its waiting state pushes instead, so the notification says so.
  await s.api.postItem(input.waiting ? { ...item, quiet: true } : item);
  ctx.store.updateState((st) => {
    st.asked[decision.id] = {
      question: decision.question,
      options: decision.options,
      askedAt: decision.createdAt,
      to: decision.to,
      body: decision,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(decision.source.session && !input.held ? { session: decision.source.session } : {}),
      ...(decision.source.sessionTitle ? { sessionTitle: decision.source.sessionTitle } : {}),
      project: decision.source.project,
      ...(decision.answerIn ? { answerIn: true } : {}),
      ...(decision.done ? { done: true } : {}),
      ...(input.codex && decision.source.session ? { codex: input.codex } : {}),
      ...(input.extensionAnswers && decision.source.session ? { extensionAnswers: true } : {}),
      ...(input.held ? { held: true } : {}),
    };
  });
  if (input.waiting) await markWaiting(ctx, () => postWaiting(ctx, s, decision.id, "waiting"));
  return decision;
}

/** Posts a decision and prints its id; with `wait`, then waits for its answer. */
export async function ask(
  ctx: Ctx,
  input: AskInput,
  opts: { wait?: boolean; timeout?: string; json?: boolean },
): Promise<number> {
  const s = session(ctx);
  const resolved = resolveSource(input, ctx.env, process.cwd());
  const decision = await postDecision(ctx, s, { ...resolved, waiting: input.waiting || opts.wait });
  ctx.out(decision.id);
  // With no agent, nothing tells which sessions run a mod: the poller's lease says only that one
  // does (#537).
  if (!opts.wait) ctx.err(deliveryLine(decision.id, delivery(resolved, false, false)));
  if (!opts.wait) return 0;
  return wait(ctx, { id: decision.id, timeout: opts.timeout, json: opts.json }, s);
}

/**
 * Posts decision `id`'s waiting state under the one id it keeps. Only a flip to `waiting`
 * pushes; posting the state it already has does nothing. Returns whether it
 * posted. A decision answered meanwhile throws a UsageError saying so.
 */
export async function postWaiting(
  ctx: Ctx,
  s: Session,
  id: string,
  state: Waiting["state"],
): Promise<boolean> {
  const asked = ctx.store.state().asked[id];
  if (!asked) throw new UsageError(`${id} is not a decision this machine asked`);
  if (ctx.store.state().answers[id] || asked.settled)
    throw new UsageError(`${id} is already answered`);
  if ((asked.waiting?.state ?? "working") === state) return false;
  // The id is kept before the first post, so a lost reply or a second process reuses it.
  let waitingId = "";
  ctx.store.updateState((st) => {
    const a = st.asked[id];
    if (!a) return;
    a.waiting ??= { id: `w_${randomBytes(12).toString("base64url")}`, state: "working" };
    waitingId = a.waiting.id;
  });
  const dir = await refreshDirectory(ctx, s);
  const to = devices(dir);
  const body = {
    v: 1 as const,
    id: waitingId,
    decisionId: id,
    to: to.map((d) => d.id),
    at: iso(ctx.now()),
    state,
    dir: signedHead(ctx, dir),
  } satisfies Waiting;
  const item = seal("waiting", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to);
  try {
    // Both flips push: a phone moves the question's notification between its channels (#191).
    await s.api.postItem(item);
  } catch (e) {
    if (e instanceof ApiError && e.code === "already-answered")
      throw new UsageError(`${id} is already answered`);
    throw e;
  }
  ctx.store.updateState((st) => {
    const a = st.asked[id];
    if (a) a.waiting = { id: body.id, state };
  });
  return true;
}

/** `starbridge waiting <id>` and `starbridge working <id>`. */
export async function setWaiting(
  ctx: Ctx,
  opts: { id?: string; state: Waiting["state"] },
): Promise<number> {
  if (!opts.id) throw new UsageError(`${opts.state} needs a decision id`);
  const s = session(ctx);
  await postWaiting(ctx, s, opts.id, opts.state);
  // Without the agent nothing polls meanwhile: read every page since the question was asked,
  // so the owner's latest snooze is among them.
  if (opts.state === "waiting") {
    let cursor = ctx.store.state().asked[opts.id]?.cursor;
    for (let page = 0; page < 100; page++) {
      const next = (await poll(ctx, s, { cursor, seconds: 0, shared: false })).cursor;
      if (next === cursor) break;
      cursor = next;
    }
  }
  const until = snoozedUntil(ctx.store.state(), opts.id, ctx.now());
  if (until && opts.state === "waiting")
    ctx.out(snoozeLine(opts.id, ctx.store.state().asked[opts.id]?.question, until, ctx.now()));
  return 0;
}

/**
 * Closes a decision this machine asked without a Starbridge answer: answered on its `answerIn`
 * page (`elsewhere`), or no longer needed (`withdrawn`). Every device moves it out of the open
 * inbox.
 */
export interface SettleOpts {
  id?: string;
  /** Checked here: it comes from the command line. */
  outcome?: string;
  /** Every open decision the session asked. */
  session?: string;
  /** Every open decision this machine asked, once `confirm` agrees. */
  all?: boolean;
  confirm?: (question: string) => Promise<boolean>;
}

export async function settle(ctx: Ctx, opts: SettleOpts): Promise<number> {
  const { id, session: sessionId, all } = opts;
  if ([id, sessionId, all].filter((x) => x).length !== 1)
    throw new UsageError("settle needs a decision id, --session <id> or --all");
  if (opts.outcome !== undefined && opts.outcome !== "elsewhere" && opts.outcome !== "withdrawn")
    throw new UsageError("--outcome is elsewhere or withdrawn");
  const outcome = opts.outcome as "elsewhere" | "withdrawn" | undefined;
  if (id) {
    const asked = ctx.store.state().asked[id];
    if (!asked) throw new UsageError(`${id} is not a decision this machine asked`);
    const s = session(ctx);
    await settleOne(ctx, s, await refreshDirectory(ctx, s), id, outcome);
    return 0;
  }
  return settleMany(ctx, opts, outcome);
}

/**
 * `settle --session` and `--all`: a flooded account's way out (#584). Each decision is one
 * settled item, posted at the pace the server's 429s set: a machine posts 90 a minute.
 */
async function settleMany(
  ctx: Ctx,
  opts: SettleOpts,
  outcome: "elsewhere" | "withdrawn" | undefined,
): Promise<number> {
  const st = ctx.store.state();
  const open = Object.entries(st.asked)
    // A settle whose notice failed is posted again.
    .filter(([id, a]) => (!a.settled || a.unposted) && !a.revoked && !st.answers[id])
    .filter(([, a]) => opts.all || a.session === opts.session)
    .map(([id]) => id);
  const whose = opts.all ? "this machine asked" : `session ${opts.session} asked`;
  if (open.length === 0) {
    ctx.out(`No open decision ${whose}.`);
    return 0;
  }
  if (opts.all && !(await opts.confirm?.(`Settle all ${open.length} open decisions ${whose}?`)))
    return 1;
  const s = session(ctx);
  const dir = await refreshDirectory(ctx, s);
  let done = 0;
  for (const [i, id] of open.entries()) {
    for (;;) {
      if (ctx.signal?.aborted) {
        ctx.err(`starbridge: stopped after settling ${done} of ${open.length}`);
        return 130;
      }
      try {
        if (await settleOne(ctx, s, dir, id, outcome, true)) done++;
        break;
      } catch (e) {
        if (!(e instanceof ApiError && e.retryAfter)) {
          ctx.err(`starbridge: settled ${done} of ${open.length}; run it again to go on`);
          throw e;
        }
        await ctx.sleep(e.retryAfter * 1000);
      }
    }
    if ((i + 1) % 100 === 0 && i + 1 < open.length) ctx.out(`Settled ${done} of ${open.length}…`);
  }
  ctx.out(`Settled ${done} decision${done === 1 ? "" : "s"}.`);
  return 0;
}

/**
 * Closes decision `id` here, then tells the devices of `dir`; `bulk` for `settleMany`. False
 * when an answer closed it instead.
 */
async function settleOne(
  ctx: Ctx,
  s: Session,
  dir: Directory,
  id: string,
  outcomeOpt: "elsewhere" | "withdrawn" | undefined,
  bulk = false,
): Promise<boolean> {
  const asked = ctx.store.state().asked[id];
  // Closed by a revoked device's answer the server holds: a notice would contradict it. A
  // decision `settle` closed earlier is posted again, in case that post failed.
  if (!asked || asked.revoked) return false;
  const outcome = outcomeOpt ?? (asked.answerIn ? "elsewhere" : "withdrawn");
  // Closed here first: from now on no answer to it is accepted or delivered, even if the post fails.
  // An answer that already reached the agent closed it, and a withdrawal would contradict it;
  // checked in the same update, so a delivery in another process cannot slip in between.
  // A bulk run, which lasts hours, also leaves alone one the owner answered since it started.
  let delivered = false;
  ctx.store.updateState((st) => {
    delivered = bulk ? !!st.answers[id] : !!st.answers[id]?.seen;
    const a = st.asked[id];
    if (a && !delivered) {
      a.settled = true;
      a.unposted = true;
      forget(a);
    }
  });
  if (delivered) return false;
  const to = devices(dir);
  const body = {
    v: 1 as const,
    id: `s_${randomBytes(12).toString("base64url")}`,
    itemId: id,
    to: to.map((d) => d.id),
    at: iso(ctx.now()),
    outcome,
    dir: signedHead(ctx, dir),
  } satisfies Settled;
  try {
    await s.api.postItem(
      seal("settled", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to),
    );
  } catch (e) {
    // Answered or settled already: either way it is closed, which is what was asked. A bulk run
    // also counts one the server dropped already.
    const code = e instanceof ApiError ? e.code : undefined;
    const closed = ["already-answered", "already-settled", ...(bulk ? ["not-found"] : [])];
    if (!code || !closed.includes(code)) throw e;
  }
  ctx.store.updateState((st) => {
    const a = st.asked[id];
    if (a) delete a.unposted;
  });
  return true;
}

/** What `checkAnswer` reads of a decision this machine asked. */
type Asked = Pick<State["asked"][string], "options" | "settled" | "answerIn" | "done" | "to">;

/**
 * Checks an answer item: sealed to this machine, signed by an active device that the decision was
 * sealed to, for an open decision this machine asked that takes answers in Starbridge, with one of
 * its options or a typed reply; or, for one answered on its own page, a Done.
 */
export function checkAnswer(
  raw: unknown,
  s: Session,
  dir: Directory,
  asked: Record<string, Asked>,
): Answer {
  const item = parseWith(SealedItem, raw);
  if (item.kind !== "answer") throw new ProtocolError("wrong-kind", item.kind);
  const { body, signer } = open(
    item as SealedItem & { kind: "answer" },
    { id: s.machine.id, box: s.keys.box },
    dir,
  );
  const decision = asked[body.decisionId];
  if (!decision) throw new ProtocolError("unknown-member", `not my decision: ${body.decisionId}`);
  // A server can hold a signed answer back and release it once the agent moved on.
  if (decision.settled)
    throw new ProtocolError("id-mismatch", `${body.decisionId} is settled: no answer counts`);
  // A decision answered on its own page takes a Done, when it asked for one, and nothing else.
  if (!!body.done !== !!(decision.answerIn && decision.done))
    throw new ProtocolError(
      "id-mismatch",
      decision.answerIn
        ? `${body.decisionId} is answered on its own page`
        : `${body.decisionId} takes no Done`,
    );
  // Decisions asked before the machine kept recipients have none, and take no answer.
  if (!decision.to?.includes(signer.id))
    throw new ProtocolError("unknown-member", `${body.decisionId} was not sent to ${signer.id}`);
  // A typed reply answers any decision (`replies`); a choice must be one of its options. The
  // schema already holds an answer to exactly one of the two.
  if (body.choice !== undefined && !decision.options.includes(body.choice))
    throw new ProtocolError("bad-schema", "choice is not one of the options");
  return body;
}

/**
 * Keeps the owner's snooze of a decision this machine asked (#571), when a device it was sealed
 * to signed it and it is newer than the one kept. A snooze is not an answer: it only tells `wait`
 * and `waiting` that none comes before its time.
 */
export function acceptSnooze(raw: unknown, s: Session, dir: Directory, st: State): void {
  const item = parseWith(SealedItem, raw);
  if (item.kind !== "snooze") throw new ProtocolError("wrong-kind", item.kind);
  const { body, signer } = open(
    item as SealedItem & { kind: "snooze" },
    { id: s.machine.id, box: s.keys.box },
    dir,
  );
  const decision = st.asked[body.decisionId];
  if (!decision?.to?.includes(signer.id)) return;
  const kept = decision.snooze;
  if (kept && Date.parse(kept.at) >= Date.parse(body.at)) return;
  decision.snooze = { until: body.until, at: body.at };
}

/** Until when the owner snoozed decision `id`, while that time is still to come and no answer is. */
export function snoozedUntil(st: State, id: string, now: Date): string | undefined {
  const a = st.asked[id];
  const until = a?.snooze?.until;
  // Held while the directory is behind, as answers are: a newer word may be among the held.
  if (!until || a.settled || st.answers[id] || st.behind) return undefined;
  // Back now ends at its own time, read before this machine's clock: the device's may run ahead.
  if (Date.parse(until) <= Date.parse(a.snooze?.at ?? "")) return undefined;
  if (Date.parse(until) <= now.getTime()) return undefined;
  return until;
}

/** Decision `id`'s snooze, once per snooze: `wait` says it and exits, then waits on. */
export function takeSnooze(store: Ctx["store"], id: string, now: Date): string | undefined {
  const st = store.state();
  if (!snoozedUntil(st, id, now) || st.asked[id]?.snooze?.told) return undefined;
  let until: string | undefined;
  store.updateState((st) => {
    const s = st.asked[id]?.snooze;
    if (!s || s.told || !snoozedUntil(st, id, now)) return;
    s.told = true;
    until = s.until;
  });
  return until;
}

/**
 * "18:00", "tomorrow 09:00", "Fri 09:00": when a snooze ends, in this machine's zone and 24-hour
 * time, as an agent reads it.
 */
export function snoozeTime(until: Date, now: Date): string {
  const time = until.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => d.toDateString();
  if (day(until) === day(now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (day(until) === day(tomorrow)) return `tomorrow ${time}`;
  return `${until.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** The line `wait` and `waiting` print for a snoozed decision; the skill tells agents what it means. */
export function snoozeLine(id: string, question: string | undefined, until: string, now: Date) {
  return `Snoozed ${id}${question ? ` (${question})` : ""} until ${snoozeTime(new Date(until), now)}: no answer before then.`;
}

/**
 * Whether decision `id`'s answer may reach its session: not settled, taking answers (a Done for
 * one answered on its own page), and the machine not behind on the directory.
 */
export function deliverable(st: State, id: string): boolean {
  const asked = st.asked[id];
  return !!asked && !asked.settled && (!asked.answerIn || !!asked.done) && !st.behind;
}

/** Answers held at most while the directory is behind. */
const HELD_MAX = 100;

/**
 * Records the directory head a device signed into answer `raw`. A shorter head never replaces a
 * longer one the chain lacks, so replaying an older answer cannot lift a refusal. Returns the
 * device that signed `raw` when it is an answer an active device signed.
 */
export function noteHead(
  raw: unknown,
  s: Session,
  dir: Directory,
  entries: unknown[],
  st: State,
): string | undefined {
  const item = SealedItem.safeParse(raw);
  const kind = item.success ? item.data.kind : undefined;
  // A snooze is a device's word too, with the head it signed (#571).
  if (!item.success || (kind !== "answer" && kind !== "permission-answer" && kind !== "snooze"))
    return undefined;
  let opened: ReturnType<typeof open<"answer" | "permission-answer" | "snooze">>;
  try {
    opened = open(
      item.data as SealedItem & { kind: "answer" | "permission-answer" | "snooze" },
      { id: s.machine.id, box: s.keys.box },
      dir,
    );
  } catch {
    return undefined;
  }
  // A device vouches for its own head only: a `by` in an answer would add a key per id it names.
  const head = opened.body.dir && { length: opened.body.dir.length, head: opened.body.dir.head };
  st.heads ??= {};
  keepHead(st.heads, opened.signer.id, head, entries);
  return opened.signer.id;
}

/**
 * Why no answer counts now: a device active in `dir` signed a head the machine's chain `entries`
 * lacks, so the server is holding back entries, perhaps the revocation of a device that answers.
 */
export function behindBy(st: State, dir: Directory, entries: unknown[]): string | undefined {
  const held = withheldBy(st.heads ?? {}, dir, entries);
  if (held)
    return `the server is holding back directory entries ${held.id} has seen (${held.head.length}, this machine has ${dir.length}): no answer counts until it serves them`;
  return undefined;
}

/**
 * How an answer comes back into the session that asked: as a prompt, which Claude Code's mod,
 * the Pi extension and the opencode plugin submit and the agent queues into a Codex session it
 * can reach, or only through `wait`.
 */
export type Delivery = "prompt" | "wait";

/**
 * A prompt only when something will submit it (#537): for Claude Code, a mod seen polling for
 * this session (`modSeen`), which an installed plugin alone does not mean; for Pi and opencode,
 * their extension, which says so itself; for Codex, its reachable app-server. With no agent
 * running, Codex gets nothing back.
 */
export function delivery(
  input: Pick<AskInput, "agent" | "extensionAnswers" | "headless">,
  codexReachable: boolean,
  modSeen: boolean,
): Delivery {
  if (input.agent === "claude-code") return !input.headless && modSeen ? "prompt" : "wait";
  if (input.agent === "pi" || input.agent === "opencode")
    return input.extensionAnswers ? "prompt" : "wait";
  return input.agent === "codex" && codexReachable ? "prompt" : "wait";
}

/**
 * How long after its last call the agent still counts a session's mod as there: one events call
 * held 25 s, and the next one.
 */
export const MOD_SEEN_MS = 45_000;

/** What `ask` prints after the id, on stderr, so the asking agent knows what to do next. */
export function deliveryLine(id: string, d: Delivery): string {
  return d === "prompt"
    ? "The answer will come back into this session as a new prompt."
    : `Nothing brings the answer into this session: when only the answer is left, run \`starbridge wait ${id} --timeout 5m\` (again on exit 2).`;
}

/** The line `wait` prints and the mod submits; the decision skill tells agents to expect it. */
export function answerLine(a: Answer, question: string | undefined): string {
  const what = a.choice ?? a.text ?? DONE_LINE;
  return `Answer to ${a.decisionId}${question ? ` (${question})` : ""}: ${what}`;
}

/** What a Done says to the agent: the answer is on the page the question named (#539). */
export const DONE_LINE = "answered on its page; read the answer there";

function printAnswer(ctx: Ctx, a: Answer, question: string | undefined, json?: boolean) {
  ctx.out(json ? JSON.stringify(a) : answerLine(a, question));
}

/**
 * One long-poll for answers from `cursor`: keeps the verified ones in the state, and with
 * `shared` moves the shared cursor unless another process moved it meanwhile. Throws on a
 * network or server error, leaving the cursor where it was so a retry fetches the same answers.
 */
export async function poll(
  ctx: Ctx,
  s: Session,
  opts: {
    cursor?: string;
    seconds: number;
    shared: boolean;
    directory?: Directory;
    /**
     * The agent's poll also returns when a device joins or asks for quotas (PROTOCOL.md,
     * "Answers for machines"); `quotaAsked` is the last ask the server reported.
     */
    watch?: { quotaAsked?: string };
  },
): Promise<{ cursor?: string; directory: Directory; quotaAsked?: string }> {
  // `ctx.signal` cuts every request: Ctrl-C, or a hook's deadline.
  let directory = opts.directory ?? (await refreshDirectory(ctx, s, ctx.signal));
  const page = await s.api.answers(
    opts.cursor,
    opts.seconds,
    ctx.signal,
    opts.watch && { directory: directory.length, ...opts.watch },
  );
  const quotaAsked = page.quotaAsked !== undefined ? { quotaAsked: page.quotaAsked } : {};
  if (page.items.length === 0 && (page.directory ?? 0) > directory.length)
    directory = await refreshDirectory(ctx, s, ctx.signal);
  const before = ctx.store.state();
  if (page.items.length > 0 || before.held?.length || before.behind) {
    // A new device may have answered since the directory was read.
    directory = await refreshDirectory(ctx, s, ctx.signal);
    const dir = directory;
    const entries = ctx.store.directory();
    ctx.store.updateState((st) => {
      // Two processes polling from their own cursors fetch the same items: keep one of each.
      const ids = new Set<unknown>();
      const items = [...(st.held ?? []), ...page.items].filter((raw) => {
        const id = (raw as { id?: unknown } | null)?.id;
        if (id === undefined) return true;
        if (ids.has(id)) return false;
        ids.add(id);
        return true;
      });
      delete st.held;
      // Every head first: a withheld entry any answer names holds back the whole page.
      const signers = new Map(items.map((raw) => [raw, noteHead(raw, s, dir, entries, st)]));
      // Snoozes wait with the answers (#571): a device's word, to read once nothing is withheld.
      const answers = items.filter(
        (raw) =>
          signers.get(raw) !== undefined || (raw as { kind?: unknown } | null)?.kind === "snooze",
      );
      const behind = behindBy(st, dir, entries);
      if (behind) {
        // Kept, not dropped: the device's client counts them sent, and the server takes no other.
        st.behind = behind;
        st.held = answers.slice(-HELD_MAX);
        ctx.err(`starbridge: holding ${st.held.length} answers: ${behind}`);
      } else {
        delete st.behind;
        dropRevoked(st, dir);
        for (const raw of items) {
          try {
            // Machines' inboxes hold answers to decisions and to permission prompts (#57), and
            // the owner's snoozes (#571).
            if ((raw as { kind?: unknown } | null)?.kind === "snooze") {
              acceptSnooze(raw, s, dir, st);
              continue;
            }
            if ((raw as { kind?: unknown } | null)?.kind === "permission-answer") {
              const { answer, device } = acceptPermissionAnswer(raw, s, dir, st, Date.now());
              const p = st.permissions?.[answer.permissionId];
              if (p) p.answer = { ...answer, device };
              continue;
            }
            const a = checkAnswer(raw, s, dir, st.asked);
            const device = signers.get(raw);
            st.answers[a.decisionId] ??= {
              answer: a,
              seen: false,
              ...(device ? { device, announce: true } : {}),
            };
            const asked = st.asked[a.decisionId];
            if (asked) forget(asked);
          } catch (e) {
            ctx.err(`starbridge: ignored an answer: ${(e as Error).message}`);
          }
        }
      }
      if (opts.shared && st.cursor === opts.cursor && page.cursor !== undefined)
        st.cursor = page.cursor;
    });
  } else {
    // A revocation brings no answer, but voids those still waiting for their session (#491).
    // `before` is a fresh read, so trying on it costs no write when nothing is dropped.
    const dir = directory;
    if (dropRevoked(before, dir)) ctx.store.updateState((st) => dropRevoked(st, dir));
  }
  await announce(ctx, s, directory);
  // A device that joined since reads nothing this machine sealed before: re-seal it.
  await reseal(ctx, s, directory).catch((e) =>
    ctx.err(`starbridge: could not re-send open questions: ${(e as Error).message}`),
  );
  return { cursor: page.cursor ?? opts.cursor, directory, ...quotaAsked };
}

/**
 * Tells every device which answer this machine accepted, in a settled notice: the answer itself
 * is sealed only to this machine, so a device that lost a race to it could not know (#330).
 * Left to the next poll when the post fails.
 */
async function announce(ctx: Ctx, s: Session, dir: Directory): Promise<void> {
  const st = ctx.store.state();
  // Behind on the directory, it would seal to a device the server knows revoked: later.
  if (st.behind) return;
  const due = Object.entries(st.answers).filter(([, a]) => a.announce && a.device);
  if (due.length === 0) return;
  // No active device left: nobody to tell.
  const to = activeMembers(dir, "device");
  for (const [id, { answer, device }] of due) {
    const body = {
      v: 1 as const,
      id: `s_${randomBytes(12).toString("base64url")}`,
      itemId: id,
      to: to.map((d) => d.id),
      at: iso(ctx.now()),
      outcome: "device" as const,
      device: device as string,
      // A Done repeats nothing: devices read a device's notice without either as one.
      ...(answer.choice !== undefined
        ? { choice: answer.choice }
        : answer.text !== undefined
          ? { text: answer.text }
          : {}),
      dir: signedHead(ctx, dir),
    } satisfies Settled;
    try {
      if (to.length > 0)
        await s.api.postItem(
          seal("settled", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to),
          ctx.signal,
        );
    } catch (e) {
      // Settled already (withdrawn meanwhile, say) or gone: nothing left to tell.
      const done = e instanceof ApiError && (e.code === "already-settled" || e.status === 404);
      if (!done) {
        ctx.err(`starbridge: could not tell the devices which answer won: ${(e as Error).message}`);
        // Offline or cut off by a deadline: the rest would fail the same way.
        if (!(e instanceof ApiError)) return;
        continue;
      }
    }
    ctx.store.updateState((st) => {
      const a = st.answers[id];
      if (a) delete a.announce;
    });
  }
}

/** Drops a closed decision's body, so its plaintext does not stay on disk. */
/**
 * Drops the answers accepted but not yet delivered whose device the chain now revokes, such as
 * one accepted while the server withheld that revocation, or before the owner revoked a stolen
 * device: a revoked device's answer never reaches a session.
 */
function dropRevoked(st: State, dir: Directory): boolean {
  const revoked = (device: string | undefined) =>
    device !== undefined && !dir.members.get(device)?.active;
  let dropped = false;
  for (const [id, a] of Object.entries(st.answers))
    if (!a.seen && revoked(a.device)) {
      delete st.answers[id];
      // The server holds it answered, so no device can answer it again: closed (#515).
      const asked = st.asked[id];
      if (asked) {
        asked.settled = true;
        asked.revoked = true;
        forget(asked);
      }
      dropped = true;
    }
  for (const p of Object.values(st.permissions ?? {}))
    if (p.answer && !p.settled && revoked(p.answer.device)) {
      delete p.answer;
      dropped = true;
    }
  return dropped;
}

/**
 * Before a saved answer is handed out without a poll: drops those from devices revoked since,
 * against the directory as the server has it now, else as this machine last verified it. Only
 * when there is an undelivered answer from a device, so a call with nothing to hand out stays
 * offline.
 */
export async function dropRevokedNow(ctx: Ctx) {
  const st = ctx.store.state();
  if (!Object.values(st.answers).some((a) => !a.seen && a.device)) return;
  const s = session(ctx);
  let dir: Directory;
  try {
    dir = await refreshDirectory(ctx, s, ctx.signal);
  } catch {
    dir = verifyDirectory(ctx.store.directory(), {
      account: s.machine.account,
      pin: s.machine.pin,
    });
  }
  if (dropRevoked(st, dir)) ctx.store.updateState((fresh) => dropRevoked(fresh, dir));
}

function forget(a: State["asked"][string]) {
  delete a.body;
}

/** The server drops an unanswered decision after 30 days; one re-sealed later would come back. */
const RESEAL_MS = 29 * 24 * 3600_000;

/**
 * Re-seals this machine's open decisions, with their waiting state, and permission prompts to
 * the active devices of the verified directory when one of those was not among their
 * recipients. They keep their ids, so a device that had them sees no second copy, and the server
 * pushes only the new devices. Revoked devices get nothing, and nothing is re-sealed while the
 * server may be withholding directory entries.
 */
/**
 * When each store's re-seal may run again after a 429: until then the machine's rate window is
 * left to its own asks (#650).
 */
const resealPaused = new WeakMap<object, number>();

async function reseal(ctx: Ctx, s: Session, known: Directory): Promise<void> {
  const st = ctx.store.state();
  const now = ctx.now().getTime();
  if ((resealPaused.get(ctx.store) ?? 0) > now) return;
  // A decision's recipients are those of its body as last posted; `to`, whose answers count, may
  // hold more: a post whose reply was lost could have reached the server.
  const decisions = Object.entries(st.asked).flatMap(([id, a]) =>
    a.body && a.to && !a.settled && !st.answers[id] && now - Date.parse(a.askedAt) < RESEAL_MS
      ? [{ id, a, body: a.body }]
      : [],
  );
  const prompts = Object.values(st.permissions ?? {}).filter(
    (p) => !p.settled && !p.answer && Date.parse(p.permission.expiresAt) > now,
  );
  const lacking = (to: string[], dir: Directory) =>
    activeMembers(dir, "device").some((d) => !to.includes(d.id));
  const all = [
    ...decisions.map((d) => d.body.to),
    ...prompts.map((p) => p.sealedTo ?? p.permission.to),
  ];
  if (st.behind || !all.some((to) => lacking(to, known))) return;
  const dir = await refreshDirectory(ctx, s, ctx.signal);
  const to = activeMembers(dir, "device");
  const ids = to.map((d) => d.id);
  const signer = { id: s.machine.id, signKey: s.keys.sign.privateKey };
  /**
   * Posts a re-sealed item: "posted", "closed" when the server holds it answered or no longer
   * holds it, "limited" after a 429, which pauses the re-seal for its Retry-After, or undefined
   * after another error. The next poll tries the rest again.
   */
  const post = async (item: () => SealedItem) => {
    let sealed: SealedItem | undefined;
    try {
      sealed = item();
      await s.api.postItem(sealed);
      return "posted";
    } catch (e) {
      if (e instanceof ApiError && ["already-answered", "not-found"].includes(e.code))
        return "closed";
      // Asked before #720, it may be too large for this many devices: it cannot ever reach them.
      if (e instanceof ApiError && e.code === "too-large") {
        ctx.err(
          `starbridge: ${sealed?.id ?? ""} is too large to send to the new devices; it stays on the others`,
        );
        return "closed";
      }
      if (e instanceof ApiError && e.status === 429) {
        resealPaused.set(ctx.store, ctx.now().getTime() + (e.retryAfter ?? 60) * 1000);
        return "limited";
      }
      ctx.err(`starbridge: could not re-send ${sealed?.id ?? ""}: ${(e as Error).message}`);
    }
  };
  for (const { id, a, body } of decisions) {
    if (!lacking(body.to, dir)) continue;
    ctx.store.updateState((st) => {
      const x = st.asked[id];
      if (x) x.to = [...new Set([...(x.to ?? []), ...ids])];
    });
    // Without blobs: the server keeps the images, sealed once for every device (#685).
    const posted = await post(() => ({
      ...seal("decision", { ...body, to: ids, dir: signedHead(ctx, dir) }, signer, to),
      reseal: true,
    }));
    if (posted === "closed")
      ctx.store.updateState((st) => {
        const x = st.asked[id];
        if (x) forget(x);
      });
    if (posted === "limited") return;
    if (posted !== "posted") continue;
    // Done once its waiting state went too; else the next poll re-sends both.
    if (a.waiting?.state === "waiting") {
      const w = {
        v: 1 as const,
        id: a.waiting.id,
        decisionId: id,
        to: ids,
        at: iso(ctx.now()),
        state: a.waiting.state,
        dir: signedHead(ctx, dir),
      } satisfies Waiting;
      const sent = await post(() => ({ ...seal("waiting", w, signer, to), quiet: true }));
      if (sent === "limited") return;
      if (!sent) continue;
    }
    ctx.store.updateState((st) => {
      const x = st.asked[id];
      if (x?.body) x.body.to = ids;
    });
  }
  for (const p of prompts) {
    if (!lacking(p.sealedTo ?? p.permission.to, dir)) continue;
    const permission = { ...p.permission, to: ids, dir: signedHead(ctx, dir) };
    // As for decisions: answers count from the new devices before the post. `sealedTo` keeps the
    // devices that hold it, so a failed post is tried again on the next poll.
    ctx.store.updateState((st) => {
      const x = st.permissions?.[permission.id];
      if (!x) return;
      x.sealedTo ??= x.permission.to;
      x.permission.to = [...new Set([...x.permission.to, ...ids])];
    });
    // Closed: answered or gone on the server, so no device needs it any more.
    const sent = await post(() => ({
      ...seal("permission", permission, signer, to),
      reseal: true,
    }));
    if (sent === "limited") return;
    if (sent === undefined) continue;
    ctx.store.updateState((st) => {
      const x = st.permissions?.[permission.id];
      if (x) x.sealedTo = ids;
    });
  }
}

/**
 * The answer to decision `id`, or without `id` the first answer no `wait` printed yet to a
 * decision session `session` asked (any session's when undefined), marked printed. Undefined
 * when there is none yet.
 */
export function takeAnswer(
  store: Ctx["store"],
  id: string | undefined,
  session?: string,
): { answer: Answer; question?: string } | undefined {
  const mine = (st: State, d: string) =>
    !st.asked[d]?.held && (session === undefined || (st.asked[d]?.session ?? "") === session);
  const found = (st: State) =>
    id
      ? deliverable(st, id)
        ? st.answers[id]
        : undefined
      : Object.values(st.answers).find(
          (a) => !a.seen && deliverable(st, a.answer.decisionId) && mine(st, a.answer.decisionId),
        );
  if (!found(store.state())) return undefined;
  let taken: { answer: Answer; question?: string } | undefined;
  store.updateState((st) => {
    const a = found(st);
    if (!a) return;
    a.seen = true;
    const question = st.asked[a.answer.decisionId]?.question;
    taken = { answer: a.answer, ...(question !== undefined ? { question } : {}) };
  });
  return taken;
}

/**
 * Waits for the answer to decision `id`, marking it `waiting`, or without `id` for the next
 * answer to any decision this machine asked. Exits 0 with the answer, or EXIT_TIMEOUT once
 * `--timeout` passes.
 */
export async function wait(
  ctx: Ctx,
  opts: { id?: string; session?: string; timeout?: string; json?: boolean; "no-mark"?: boolean },
  s: Session = session(ctx),
  dir?: Directory,
): Promise<number> {
  const state = ctx.store.state();
  const target = opts.id;
  if (target && !state.asked[target])
    throw new UsageError(`${target} is not a decision this machine asked`);
  const closed = () => closedError(ctx, target);

  const report = (found: { answer: Answer; question?: string }) => {
    printAnswer(ctx, found.answer, found.question, opts.json);
    return 0;
  };
  // Snoozed: said once, so a polling agent stops; the next `wait` waits on (#571).
  const snoozed = () => {
    const until = target ? takeSnooze(ctx.store, target, ctx.now()) : undefined;
    if (!until || !target) return undefined;
    printSnooze(ctx, target, ctx.store.state().asked[target]?.question, until, opts.json);
    return EXIT_SNOOZED;
  };

  await dropRevokedNow(ctx);
  const shut = closed();
  if (shut) throw shut;
  const already = takeAnswer(ctx.store, target, opts.session);
  if (already) return report(already);
  if (target && !opts["no-mark"])
    await markWaiting(ctx, () => postWaiting(ctx, s, target, "waiting"));
  // A snooze is told only after a poll: the one cached may be over, or answered since.

  let deadline = Number.POSITIVE_INFINITY;
  if (opts.timeout) deadline = ctx.now().getTime() + parseDuration(opts.timeout);

  // A wait for one decision reads from where that decision was asked; a wait for any answer
  // reads from, and moves, the shared cursor.
  let cursor = target ? state.asked[target]?.cursor : state.cursor;
  let directory = dir;
  while (true) {
    const left = deadline - ctx.now().getTime();
    if (ctx.signal?.aborted) return EXIT_INTERRUPTED;
    if (left <= 0) {
      ctx.err(`No answer to ${target ?? "any decision"} yet.`);
      return EXIT_TIMEOUT;
    }
    try {
      const seconds = Math.max(1, Math.min(MAX_POLL_SECONDS, Math.ceil(left / 1000)));
      ({ cursor, directory } = await poll(ctx, s, {
        cursor,
        seconds,
        shared: !target,
        directory,
      }));
    } catch (e) {
      if (e instanceof UsageError || e instanceof ProtocolError) throw e;
      if (ctx.signal?.aborted) continue;
      ctx.err(`starbridge: ${(e as Error).message}; retrying`);
      await ctx.sleep(Math.min(RETRY_MS, Math.max(0, left)));
      continue;
    }
    const found = takeAnswer(ctx.store, target, opts.session);
    if (found) return report(found);
    const ended = closed();
    if (ended) throw ended;
    const off = snoozed();
    if (off !== undefined) return off;
  }
}

/** A snooze as `wait` prints it: the line, or `{decisionId, snoozedUntil}` with `--json`. */
export function printSnooze(
  ctx: Ctx,
  id: string,
  question: string | undefined,
  until: string,
  json?: boolean,
) {
  ctx.out(
    json
      ? JSON.stringify({ decisionId: id, snoozedUntil: until })
      : snoozeLine(id, question, until, ctx.now()),
  );
}

/** Why no answer to decision `id` will come, for `wait`: settled, answered elsewhere, or revoked. */
export function closedError(ctx: Ctx, id: string | undefined): UsageError | undefined {
  const a = id === undefined ? undefined : ctx.store.state().asked[id];
  if (a?.revoked)
    return new UsageError(
      `${id} was answered from a device removed since, so that answer does not count and no other will come: ask again if you still need it`,
    );
  if (a?.settled || (a?.answerIn && !a.done))
    return new UsageError(`${id} is settled or answered on its own page: no answer will come`);
}

/** Marks a decision waiting on the way into a wait; a failure only costs the devices' label. */
export async function markWaiting(ctx: Ctx, post: () => Promise<unknown>): Promise<void> {
  try {
    await post();
  } catch (e) {
    ctx.err(`starbridge: could not mark it waiting: ${(e as Error).message}`);
  }
}

/** Keeps a `--wait` cycle under the 30 s the mod's host allows a call to run. */
export const MAX_CYCLE_SECONDS = 25;

/** One line for a session: the answer to a decision it asked. */
export interface SessionLine {
  type: "answer";
  decisionId: string;
  /** What confirms it: the decision id. */
  ack: string;
  line: string;
}

/** The answers to decisions session `session` asked that no `wait` printed nor the mod confirmed. */
export function sessionLines(st: State, session: string): SessionLine[] {
  const lines: SessionLine[] = [];
  // Accepted before the machine knew it was behind: held back with the rest.
  if (st.behind) return lines;
  for (const [id, a] of Object.entries(st.answers)) {
    const asked = st.asked[id];
    if (!asked || a.seen || asked.session !== session || !deliverable(st, id)) continue;
    lines.push({
      type: "answer",
      decisionId: id,
      ack: id,
      line: answerLine(a.answer, asked.question),
    });
  }
  return lines;
}

/** Confirms lines session `session` submitted; tokens for other sessions' decisions do nothing. */
export function ackLines(st: State, session: string, tokens: string[]) {
  for (const token of tokens) {
    const a = st.answers[token];
    if (a && !a.seen && st.asked[token]?.session === session) a.seen = true;
  }
}

/** What `answers` prints for each line, as the mod reads it. */
const printLine = (ctx: Ctx, l: SessionLine) =>
  ctx.out(JSON.stringify({ decisionId: l.decisionId, ack: l.ack, line: l.line }));

/**
 * For the Claude Code mod: hands over the answers to decisions that session `session` asked and
 * that neither a `wait` printed nor the mod confirmed, one JSON line `{decisionId, ack, line}`
 * each. The mod confirms each line it submitted with `--ack <ack>`; until then
 * the next call hands it over again, so a line the mod held back (its session ended meanwhile) is
 * not lost. With `wait`, and nothing to hand over, first long-polls once for at most that many
 * seconds from the shared cursor. One cycle per call: an error exits 1, and the mod decides when
 * to retry. This is the path with no agent running; the agent serves the same lines.
 */
export async function answers(
  ctx: Ctx,
  opts: { session?: string; wait?: string; ack?: string[] },
): Promise<number> {
  const target = opts.session;
  if (!target) throw new UsageError("answers needs --session");
  if (opts.ack) {
    if (opts.wait !== undefined) throw new UsageError("--ack takes no --wait");
    const acked = opts.ack;
    ctx.store.updateState((st) => ackLines(st, target, acked));
    return 0;
  }
  const seconds = opts.wait === undefined ? undefined : waitSeconds(opts.wait);
  await dropRevokedNow(ctx);
  const first = sessionLines(ctx.store.state(), target);
  for (const l of first) printLine(ctx, l);
  if (first.length > 0 || seconds === undefined) return 0;
  try {
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds, shared: true });
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProtocolError) throw e;
    ctx.err(`starbridge: ${(e as Error).message}`);
    return 1;
  }
  for (const l of sessionLines(ctx.store.state(), target)) printLine(ctx, l);
  return 0;
}

/** `--wait` for `answers`: whole seconds up to MAX_CYCLE_SECONDS. */
export function waitSeconds(text: string): number {
  const seconds = Number(text);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_CYCLE_SECONDS)
    throw new UsageError(`--wait takes whole seconds from 0 to ${MAX_CYCLE_SECONDS}`);
  return seconds;
}

/** How long each server poll of `answers --all --follow` holds. */
const FOLLOW_POLL_SECONDS = 30;

/** One line of `answers --all`: an answer to a decision this machine asked, with who asked. */
export interface ObservedAnswer {
  decisionId: string;
  question: string;
  choice?: string;
  text?: string;
  done?: true;
  answeredAt: string;
  session?: string;
  sessionTitle?: string;
  project?: string;
}

/**
 * Every answer the machine accepted that its session may have, oldest first, from `since` (ms)
 * on and leaving out the decision ids in `known`. Reads only: nothing is marked seen, so the
 * session that asked still gets each one.
 */
export function observedAnswers(
  st: State,
  opts: { since?: number; known?: ReadonlySet<string> } = {},
): ObservedAnswer[] {
  if (st.behind) return [];
  const lines: ObservedAnswer[] = [];
  for (const [id, { answer }] of Object.entries(st.answers)) {
    const asked = st.asked[id];
    if (!asked || !deliverable(st, id) || opts.known?.has(id)) continue;
    if (opts.since !== undefined && Date.parse(answer.answeredAt) < opts.since) continue;
    const { session, sessionTitle, project } = asked;
    lines.push({
      decisionId: id,
      question: asked.question,
      ...(answer.choice !== undefined ? { choice: answer.choice } : {}),
      ...(answer.text !== undefined ? { text: answer.text } : {}),
      ...(answer.done ? { done: true as const } : {}),
      answeredAt: answer.answeredAt,
      ...(session ? { session } : {}),
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(project !== undefined ? { project } : {}),
    });
  }
  return lines.sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));
}

/** `--since`: a time (`2026-10-06T21:00Z`), or a duration with its unit back from now (`2h`). */
export function sinceTime(text: string, now: Date): number {
  if (/^\d+(\.\d+)?\s*[smhd]$/.test(text.trim())) return now.getTime() - parseDuration(text);
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new UsageError(`--since takes a time or a duration, not ${text}`);
  return t;
}

/**
 * `answers --all` with no agent: prints every answer `observedAnswers` holds, then with `follow`
 * polls the server from a cursor of its own, never the shared one, and prints each new answer
 * until interrupted. `printed` carries over from an agent that stopped under it.
 */
export async function answersAll(
  ctx: Ctx,
  opts: { follow?: boolean; since?: number },
  printed: Set<string> = new Set(),
): Promise<number> {
  const flush = () => {
    for (const a of observedAnswers(ctx.store.state(), { since: opts.since, known: printed })) {
      printed.add(a.decisionId);
      ctx.out(JSON.stringify(a));
    }
  };
  const s = session(ctx);
  let cursor = ctx.store.state().cursor;
  let directory: Directory | undefined;
  // Nothing else may have fetched the server's answers yet: one poll that returns at once.
  try {
    ({ cursor, directory } = await poll(ctx, s, { cursor, seconds: 0, shared: false }));
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProtocolError) throw e;
    if (!ctx.signal?.aborted)
      ctx.err(`starbridge: ${(e as Error).message}; printing what this machine has`);
  }
  if (ctx.signal?.aborted) return EXIT_INTERRUPTED;
  flush();
  if (!opts.follow) return 0;
  while (!ctx.signal?.aborted) {
    try {
      ({ cursor, directory } = await poll(ctx, s, {
        cursor,
        // Short holds: another process may release answers this poll never fetches.
        seconds: FOLLOW_POLL_SECONDS,
        shared: false,
        directory,
      }));
    } catch (e) {
      if (e instanceof UsageError || e instanceof ProtocolError) throw e;
      if (ctx.signal?.aborted) break;
      ctx.err(`starbridge: ${(e as Error).message}; retrying`);
      directory = undefined;
      await ctx.sleep(RETRY_MS);
      continue;
    }
    // The agent or a `wait` may have accepted answers this poll did not fetch.
    flush();
  }
  return EXIT_INTERRUPTED;
}

/** One line of `decisions --open`: a question this machine asked that is still open. */
export interface OpenDecision {
  decisionId: string;
  question: string;
  options: string[];
  askedAt: string;
  waiting: boolean;
  session?: string;
  sessionTitle?: string;
  project?: string;
}

/**
 * The questions this machine asked that have no answer yet, are not settled and the server still
 * holds (it drops them after 30 days), oldest first. Questions a hook waits on itself are left
 * out: no session owns them.
 */
export function openDecisions(st: State, now: Date): OpenDecision[] {
  const lines: OpenDecision[] = [];
  for (const [id, a] of Object.entries(st.asked)) {
    if (a.settled || a.held || st.answers[id]) continue;
    if (now.getTime() - Date.parse(a.askedAt) >= RESEAL_MS) continue;
    lines.push({
      decisionId: id,
      question: a.question,
      options: a.options,
      askedAt: a.askedAt,
      waiting: a.waiting?.state === "waiting",
      ...(a.session ? { session: a.session } : {}),
      ...(a.sessionTitle ? { sessionTitle: a.sessionTitle } : {}),
      ...(a.project !== undefined ? { project: a.project } : {}),
    });
  }
  return lines.sort((x, y) => x.askedAt.localeCompare(y.askedAt));
}

/** `decisions --open`: prints `openDecisions` as JSON lines, from the state file both paths share. */
export function decisionsOpen(ctx: Ctx): number {
  for (const d of openDecisions(ctx.store.state(), ctx.now())) ctx.out(JSON.stringify(d));
  return 0;
}
