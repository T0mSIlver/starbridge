import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  type Agent,
  type Answer,
  Decision,
  type DecisionLink,
  type Directory,
  open,
  ProtocolError,
  parseWith,
  SealedItem,
  type SessionLink,
  type Settled,
  seal,
  type Waiting,
} from "@starbridge/protocol";
import { ApiError } from "./api";
import { claudeSession } from "./claude";
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
  UsageError,
} from "./context";
import { fitPicture, loadPicture, type Picture } from "./images";
import { acceptPermissionAnswer } from "./permissions";

export interface AskInput {
  question?: string;
  context?: string;
  options?: string[];
  recommended?: string;
  /** What the agent does meanwhile; clients from before 2026-10-05 require one. */
  default?: string;
  /** Post it already `waiting`: the agent has nothing else to do. */
  waiting?: boolean;
  /** The coding agent asking; default: Claude Code when it runs the command. */
  agent?: Agent;
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

/** What the server stores at most for one decision, all boxes together (PROTOCOL.md, Limits). */
export const ITEM_BYTES = 256 * 1024;

/** Exit code when nobody answered before `--timeout`. */
export const EXIT_TIMEOUT = 2;
/** Sent as the default for clients from before 2026-10-05, which require one and show it. */
export const NO_DEFAULT = "Waits for your answer";
/** Exit code on Ctrl-C, as a shell reports SIGINT. */
const EXIT_INTERRUPTED = 130;
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
  const session = input.session ?? env.CLAUDE_CODE_SESSION_ID ?? "";
  const claude =
    session && (input.sessionTitle === undefined || input.sessionLinks === undefined)
      ? claudeSession(env, session)
      : undefined;
  const title = input.sessionTitle ?? claude?.title;
  const at = (path: string) => resolve(cwd, path);
  return {
    ...input,
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
    default: { action: input.default || NO_DEFAULT },
    ...agentOf(input, ctx.env),
    source: sourceFor(input, ctx, machine),
    ...(links.length > 0 ? { links } : {}),
    ...(input.answerIn !== undefined ? { answerIn: link(input.answerIn) } : {}),
  };
  return checked(decision);
}

/** `--agent`, else Claude Code when it runs this command (it sets CLAUDECODE=1). */
function agentOf(input: AskInput, env: Ctx["env"]): { agent?: Agent } {
  if (input.agent !== undefined) return { agent: input.agent };
  return env.CLAUDECODE === "1" ? { agent: "claude-code" } : {};
}

function checked(decision: unknown): Decision {
  try {
    return parseWith(Decision, decision);
  } catch (e) {
    throw e instanceof ProtocolError ? new UsageError(`bad decision: ${e.message}`) : e;
  }
}

const boxBytes = (item: SealedItem) => item.boxes.reduce((n, b) => n + b.box.length, 0);

/**
 * Signs and seals the decision with its pictures, scaled down until every box together fits
 * ITEM_BYTES. Each box carries every image as base64url inside the sealed base64url envelope, so
 * a byte of image costs about (4/3)² bytes per device.
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
  const perBox = boxBytes(sealed(base)) / to.length;
  let share = Math.floor(((ITEM_BYTES / to.length - perBox) * 9) / 16 / pictures.length);
  for (let tries = 0; tries < 5; tries++) {
    if (share < 1024) break;
    const decision = checked({ ...base, images: pictures.map((p) => fitPicture(p, share)) });
    const item = sealed(decision);
    const size = boxBytes(item);
    if (size <= ITEM_BYTES) return { decision, item };
    share = Math.floor(share * (ITEM_BYTES / size) * 0.95);
  }
  throw new UsageError(
    `the images do not fit in one decision for ${to.length} devices: attach fewer images`,
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
  const base = buildDecision(
    input,
    ctx,
    s.machine.name,
    to.map((d) => d.id),
  );
  const { decision, item } = sealWithPictures(
    base,
    pictures,
    { id: s.machine.id, signKey: s.keys.sign.privateKey },
    to,
  );
  // A wait for this decision starts at the cursor known now, so it never misses its answer.
  const cursor = ctx.store.state().cursor;
  await s.api.postItem(item);
  ctx.store.updateState((st) => {
    st.asked[decision.id] = {
      question: decision.question,
      options: decision.options,
      askedAt: decision.createdAt,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(decision.source.session ? { session: decision.source.session } : {}),
      ...(decision.answerIn ? { answerIn: true } : {}),
    };
  });
  // Its own push already notified, so this state goes quietly.
  if (input.waiting)
    await markWaiting(ctx, () => postWaiting(ctx, s, decision.id, "waiting", true));
  return decision;
}

/** Posts a decision and prints its id; with `wait`, then waits for its answer. */
export async function ask(
  ctx: Ctx,
  input: AskInput,
  opts: { wait?: boolean; timeout?: string; json?: boolean },
): Promise<number> {
  const s = session(ctx);
  const decision = await postDecision(ctx, s, { ...input, waiting: input.waiting || opts.wait });
  ctx.out(decision.id);
  if (!opts.wait) return 0;
  return wait(ctx, { id: decision.id, timeout: opts.timeout, json: opts.json }, s);
}

/**
 * Posts decision `id`'s waiting state under the one id it keeps. Only a flip to `waiting`
 * pushes, unless `quiet`; posting the state it already has does nothing. Returns whether it
 * posted. A decision answered meanwhile throws a UsageError saying so.
 */
export async function postWaiting(
  ctx: Ctx,
  s: Session,
  id: string,
  state: Waiting["state"],
  quiet = false,
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
  const to = devices(await refreshDirectory(ctx, s));
  const body = {
    v: 1 as const,
    id: waitingId,
    decisionId: id,
    to: to.map((d) => d.id),
    at: iso(ctx.now()),
    state,
  } satisfies Waiting;
  const item = seal("waiting", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to);
  try {
    await s.api.postItem(quiet || state === "working" ? { ...item, quiet: true } : item);
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
  await postWaiting(ctx, session(ctx), opts.id, opts.state);
  return 0;
}

/**
 * Closes a decision this machine asked without a Starbridge answer: answered on its `answerIn`
 * page (`elsewhere`), or no longer needed (`withdrawn`). Every device moves it out of the open
 * inbox.
 */
export async function settle(ctx: Ctx, opts: { id?: string; outcome?: string }): Promise<number> {
  const id = opts.id;
  if (!id) throw new UsageError("settle needs a decision id");
  const asked = ctx.store.state().asked[id];
  if (!asked) throw new UsageError(`${id} is not a decision this machine asked`);
  const outcome = opts.outcome ?? (asked.answerIn ? "elsewhere" : "withdrawn");
  if (outcome !== "elsewhere" && outcome !== "withdrawn")
    throw new UsageError("--outcome is elsewhere or withdrawn");
  const s = session(ctx);
  const to = devices(await refreshDirectory(ctx, s));
  const body = {
    v: 1 as const,
    id: `s_${randomBytes(12).toString("base64url")}`,
    itemId: id,
    to: to.map((d) => d.id),
    at: iso(ctx.now()),
    outcome,
  } satisfies Settled;
  try {
    await s.api.postItem(
      seal("settled", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to),
    );
  } catch (e) {
    // Answered or settled already: either way it is closed, which is what was asked.
    const closed =
      e instanceof ApiError && ["already-answered", "already-settled"].includes(e.code);
    if (!closed) throw e;
  }
  ctx.store.updateState((st) => {
    const a = st.asked[id];
    if (a) a.settled = true;
  });
  return 0;
}

/**
 * Checks an answer item: sealed to this machine, signed by an active device, for a decision this
 * machine asked, with one of that decision's options (or free text when it had none).
 */
export function checkAnswer(
  raw: unknown,
  s: Session,
  dir: Directory,
  asked: Record<string, { options: string[] }>,
): Answer {
  const item = parseWith(SealedItem, raw);
  if (item.kind !== "answer") throw new ProtocolError("wrong-kind", item.kind);
  const { body } = open(
    item as SealedItem & { kind: "answer" },
    { id: s.machine.id, box: s.keys.box },
    dir,
  );
  const decision = asked[body.decisionId];
  if (!decision) throw new ProtocolError("unknown-member", `not my decision: ${body.decisionId}`);
  if (decision.options.length > 0) {
    if (body.choice === undefined || !decision.options.includes(body.choice))
      throw new ProtocolError("bad-schema", "choice is not one of the options");
  } else if (body.text === undefined) {
    throw new ProtocolError("bad-schema", "free-text decision answered with a choice");
  }
  return body;
}

/** The line `wait` prints and the mod submits; the decision skill tells agents to expect it. */
export function answerLine(a: Answer, question: string | undefined): string {
  const what = a.choice !== undefined ? a.choice : a.text;
  return `Answer to ${a.decisionId}${question ? ` (${question})` : ""}: ${what}`;
}

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
  let directory = opts.directory ?? (await refreshDirectory(ctx, s));
  const page = await s.api.answers(
    opts.cursor,
    opts.seconds,
    ctx.signal,
    opts.watch && { directory: directory.length, ...opts.watch },
  );
  const quotaAsked = page.quotaAsked !== undefined ? { quotaAsked: page.quotaAsked } : {};
  if (page.items.length === 0 && (page.directory ?? 0) > directory.length)
    directory = await refreshDirectory(ctx, s);
  if (page.items.length > 0) {
    // A new device may have answered since the directory was read.
    directory = await refreshDirectory(ctx, s);
    const dir = directory;
    ctx.store.updateState((st) => {
      for (const raw of page.items) {
        try {
          // Machines' inboxes hold answers to decisions and to permission prompts (#57).
          if ((raw as { kind?: unknown } | null)?.kind === "permission-answer") {
            const { answer, device } = acceptPermissionAnswer(raw, s, dir, st, Date.now());
            const p = st.permissions?.[answer.permissionId];
            if (p) p.answer = { ...answer, device };
            continue;
          }
          const a = checkAnswer(raw, s, dir, st.asked);
          st.answers[a.decisionId] ??= { answer: a, seen: false };
        } catch (e) {
          ctx.err(`starbridge: ignored an answer: ${(e as Error).message}`);
        }
      }
      if (opts.shared && st.cursor === opts.cursor && page.cursor !== undefined)
        st.cursor = page.cursor;
    });
  }
  return { cursor: page.cursor ?? opts.cursor, directory, ...quotaAsked };
}

/**
 * The answer to decision `id`, or without `id` the first answer no `wait` printed yet, marked
 * printed. Undefined when there is none yet.
 */
export function takeAnswer(
  store: Ctx["store"],
  id: string | undefined,
): { answer: Answer; question?: string } | undefined {
  const found = (st: State) =>
    id ? st.answers[id] : Object.values(st.answers).find((a) => !a.seen);
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
  opts: { id?: string; timeout?: string; json?: boolean },
  s: Session = session(ctx),
  dir?: Directory,
): Promise<number> {
  const state = ctx.store.state();
  const target = opts.id;
  if (target && !state.asked[target])
    throw new UsageError(`${target} is not a decision this machine asked`);

  const report = (found: { answer: Answer; question?: string }) => {
    printAnswer(ctx, found.answer, found.question, opts.json);
    return 0;
  };

  const already = takeAnswer(ctx.store, target);
  if (already) return report(already);
  if (target) await markWaiting(ctx, () => postWaiting(ctx, s, target, "waiting"));

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
    const found = takeAnswer(ctx.store, target);
    if (found) return report(found);
  }
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
  for (const [id, a] of Object.entries(st.answers)) {
    const asked = st.asked[id];
    if (!asked || a.seen || asked.session !== session) continue;
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
