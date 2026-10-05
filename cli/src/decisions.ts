import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  type Answer,
  Decision,
  type Directory,
  open,
  ProtocolError,
  parseWith,
  SealedItem,
  type SessionLink,
  seal,
} from "@starbridge/protocol";
import { claudeSession } from "./claude";
import type { State } from "./config";
import {
  type Ctx,
  devices,
  iso,
  parseDuration,
  refreshDirectory,
  type Session,
  session,
  UsageError,
} from "./context";

export interface AskInput {
  question?: string;
  context?: string;
  options?: string[];
  recommended?: string;
  default?: string;
  /** ISO time, or a duration from now such as "30m". */
  defaultAt?: string;
  project?: string;
  session?: string;
  sessionTitle?: string;
  links?: SessionLink[];
}

/** Exit code when nobody answered before the deadline: the agent applies its default. */
export const EXIT_TIMEOUT = 2;
/** Exit code on Ctrl-C, as a shell reports SIGINT. */
const EXIT_INTERRUPTED = 130;
/** The server holds a long-poll at most this long (PROTOCOL.md). */
const MAX_POLL_SECONDS = 300;
/** Pause before retrying after a network or server error. */
const RETRY_MS = 5_000;

function timeFrom(text: string, now: Date): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const t = Date.parse(text);
    if (Number.isNaN(t)) throw new UsageError(`not a time: ${text}`);
    return iso(new Date(t));
  }
  return iso(new Date(now.getTime() + parseDuration(text)));
}

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
): AskInput & { project: string; session: string; links: SessionLink[] } {
  const session = input.session ?? env.CLAUDE_CODE_SESSION_ID ?? "";
  const claude =
    session && (input.sessionTitle === undefined || input.links === undefined)
      ? claudeSession(env, session)
      : undefined;
  const title = input.sessionTitle ?? claude?.title;
  return {
    ...input,
    project: input.project ?? basename(cwd),
    session,
    ...(title !== undefined ? { sessionTitle: title } : {}),
    links: input.links ?? claude?.links ?? [],
  };
}

function sourceFor(input: AskInput, ctx: Ctx, machine: string): Decision["source"] {
  const r = resolveSource(input, ctx.env, process.cwd());
  return {
    machine,
    project: r.project,
    session: r.session,
    ...(r.sessionTitle ? { sessionTitle: r.sessionTitle } : {}),
    ...(r.links.length > 0 ? { links: r.links } : {}),
  };
}

export function buildDecision(input: AskInput, ctx: Ctx, machine: string, to: string[]): Decision {
  if (!input.question) throw new UsageError("ask needs --question");
  if (!input.default) throw new UsageError("ask needs --default: what you do if nobody answers");
  const options = input.options ?? [];
  const decision = {
    v: 1 as const,
    id: `d_${randomBytes(12).toString("base64url")}`,
    to,
    createdAt: iso(ctx.now()),
    question: input.question,
    context: input.context ?? "",
    options,
    ...(options.length > 0 ? { recommended: input.recommended ?? options[0] } : {}),
    default: {
      action: input.default,
      ...(input.defaultAt ? { at: timeFrom(input.defaultAt, ctx.now()) } : {}),
    },
    source: sourceFor(input, ctx, machine),
  };
  try {
    return parseWith(Decision, decision);
  } catch (e) {
    throw e instanceof ProtocolError ? new UsageError(`bad decision: ${e.message}`) : e;
  }
}

/**
 * Seals the decision to every active device, posts it and records it in the state, so its
 * answer reaches the session that asked. Returns the decision.
 */
export async function postDecision(ctx: Ctx, s: Session, input: AskInput): Promise<Decision> {
  const dir = await refreshDirectory(ctx, s);
  const to = devices(dir);
  const decision = buildDecision(
    input,
    ctx,
    s.machine.name,
    to.map((d) => d.id),
  );
  const item = seal(
    "decision",
    decision,
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
      ...(decision.default.at ? { defaultAt: decision.default.at } : {}),
      default: decision.default.action,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(decision.source.session ? { session: decision.source.session } : {}),
    };
  });
  return decision;
}

/** Posts a decision and prints its id; with `wait`, then waits for its answer. */
export async function ask(
  ctx: Ctx,
  input: AskInput,
  opts: { wait?: boolean; timeout?: string; json?: boolean },
): Promise<number> {
  const s = session(ctx);
  const decision = await postDecision(ctx, s, input);
  ctx.out(decision.id);
  if (!opts.wait) return 0;
  return wait(ctx, { id: decision.id, timeout: opts.timeout, json: opts.json }, s);
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
  opts: { cursor?: string; seconds: number; shared: boolean; directory?: Directory },
): Promise<{ cursor?: string; directory: Directory }> {
  let directory = opts.directory ?? (await refreshDirectory(ctx, s));
  const page = await s.api.answers(opts.cursor, opts.seconds, ctx.signal);
  if (page.items.length > 0) {
    // A new device may have answered since the directory was read.
    directory = await refreshDirectory(ctx, s);
    const asked = ctx.store.state().asked;
    const good: Answer[] = [];
    for (const raw of page.items) {
      try {
        good.push(checkAnswer(raw, s, directory, asked));
      } catch (e) {
        ctx.err(`starbridge: ignored an answer: ${(e as Error).message}`);
      }
    }
    ctx.store.updateState((st) => {
      for (const a of good) st.answers[a.decisionId] ??= { answer: a, seen: false };
      if (opts.shared && st.cursor === opts.cursor && page.cursor !== undefined)
        st.cursor = page.cursor;
    });
  }
  return { cursor: page.cursor ?? opts.cursor, directory };
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
 * Waits for the answer to decision `id`, or without `id` for the next answer to any decision
 * this machine asked. Exits 0 with the answer, or EXIT_TIMEOUT at the deadline: `--timeout`, else
 * the decision's default time, else never.
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

  let deadline = Number.POSITIVE_INFINITY;
  if (opts.timeout) deadline = ctx.now().getTime() + parseDuration(opts.timeout);
  else if (target && state.asked[target]?.defaultAt)
    deadline = Date.parse(state.asked[target]?.defaultAt as string);

  // A wait for one decision reads from where that decision was asked; a wait for any answer
  // reads from, and moves, the shared cursor.
  let cursor = target ? state.asked[target]?.cursor : state.cursor;
  let directory = dir;
  while (true) {
    const left = deadline - ctx.now().getTime();
    if (ctx.signal?.aborted) return EXIT_INTERRUPTED;
    if (left <= 0) {
      const what = target ?? "any decision";
      ctx.err(`No answer to ${what} yet: apply the default.`);
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

/** Keeps a `--wait` cycle under the 30 s the mod's host allows a call to run. */
export const MAX_CYCLE_SECONDS = 25;

/** The line the mod submits when a decision's default time passed with no answer. */
function defaultLine(id: string, asked: State["asked"][string]): string {
  const what = asked.default ? `apply your default: ${asked.default}` : "apply your default";
  return `No answer to ${id} (${asked.question}) by its default time ${asked.defaultAt}: ${what}`;
}

/** The `--ack` token for a default-time line; a plain decision id confirms an answer. */
const DEFAULT_ACK = ":default";

/** One line for a session: an answer, or the notice that a default time passed unanswered. */
export interface SessionLine {
  type: "answer" | "default";
  decisionId: string;
  /** What confirms it: the decision id, or `<id>:default`. */
  ack: string;
  line: string;
}

/** Whether decision `id`, asked by `session`, passed its default time with no answer. */
function overdue(st: State, session: string, id: string, now: number): boolean {
  const asked = st.asked[id];
  return (
    asked?.session === session &&
    !asked.defaulted &&
    !st.answers[id] &&
    asked.defaultAt !== undefined &&
    Date.parse(asked.defaultAt) <= now
  );
}

export function anyOverdue(st: State, session: string, now: number): boolean {
  return Object.keys(st.asked).some((id) => overdue(st, session, id, now));
}

/**
 * The lines session `session` has not confirmed: answers to decisions it asked that no `wait`
 * printed, and a notice for each of its decisions whose default time passed unanswered. A notice
 * goes out only for default times up to `checkedUntil`, the time the server was last asked for
 * answers, so an answer waiting there is never reported missing.
 */
export function sessionLines(
  st: State,
  session: string,
  now: number,
  checkedUntil: number,
): SessionLine[] {
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
  for (const [id, asked] of Object.entries(st.asked)) {
    if (!overdue(st, session, id, Math.min(now, checkedUntil))) continue;
    lines.push({
      type: "default",
      decisionId: id,
      ack: `${id}${DEFAULT_ACK}`,
      line: defaultLine(id, asked),
    });
  }
  return lines;
}

/** Confirms lines session `session` submitted; tokens for other sessions' decisions do nothing. */
export function ackLines(st: State, session: string, tokens: string[]) {
  for (const token of tokens) {
    if (token.endsWith(DEFAULT_ACK)) {
      const asked = st.asked[token.slice(0, -DEFAULT_ACK.length)];
      if (asked?.session === session) asked.defaulted = true;
      continue;
    }
    const a = st.answers[token];
    if (a && !a.seen && st.asked[token]?.session === session) a.seen = true;
  }
}

/** Milliseconds until the next default time of an unanswered decision (of `session`, if given). */
export function nextDefaultMs(st: State, now: number, session?: string): number | undefined {
  const left = Object.entries(st.asked)
    .filter(
      ([id, a]) =>
        (session === undefined || a.session === session) && !a.defaulted && !st.answers[id],
    )
    .flatMap(([, a]) => (a.defaultAt ? [Date.parse(a.defaultAt) - now] : []))
    .filter((ms) => ms > 0);
  return left.length > 0 ? Math.min(...left) : undefined;
}

/** What `answers` prints for each line, as the mod reads it. */
const printLine = (ctx: Ctx, l: SessionLine) =>
  ctx.out(JSON.stringify({ decisionId: l.decisionId, ack: l.ack, line: l.line }));

/**
 * For the Claude Code mod: hands over the answers to decisions that session `session` asked and
 * that neither a `wait` printed nor the mod confirmed, one JSON line `{decisionId, ack, line}`
 * each. A decision whose default time passed with no answer gets one line too, telling the agent
 * to apply its default. The mod confirms each line it submitted with `--ack <ack>`; until then
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
  // The owner may have answered while no poller ran: fetch what is waiting before saying nobody
  // answered. When the server cannot be reached, the notice waits for a later call.
  let checkedUntil = Number.POSITIVE_INFINITY;
  const st = ctx.store.state();
  if (anyOverdue(st, target, ctx.now().getTime())) {
    try {
      await poll(ctx, session(ctx), { cursor: st.cursor, seconds: 0, shared: true });
    } catch (e) {
      if (e instanceof UsageError || e instanceof ProtocolError) throw e;
      ctx.err(`starbridge: ${(e as Error).message}; the default-time notice waits`);
      checkedUntil = Number.NEGATIVE_INFINITY;
    }
  }
  const first = sessionLines(ctx.store.state(), target, ctx.now().getTime(), checkedUntil);
  for (const l of first) printLine(ctx, l);
  if (first.length > 0 || seconds === undefined) return 0;
  // Wake for this session's next default time, so its notice is not a whole cycle late.
  const due = nextDefaultMs(ctx.store.state(), ctx.now().getTime(), target);
  const hold = Math.min(seconds, due === undefined ? seconds : Math.ceil(due / 1000));
  const s = session(ctx);
  try {
    await poll(ctx, s, { cursor: ctx.store.state().cursor, seconds: hold, shared: true });
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProtocolError) throw e;
    ctx.err(`starbridge: ${(e as Error).message}`);
    return 1;
  }
  // That poll fetched every waiting answer, so a due notice can go now.
  for (const l of sessionLines(ctx.store.state(), target, ctx.now().getTime(), Infinity))
    printLine(ctx, l);
  return 0;
}

/** `--wait` for `answers`: whole seconds up to MAX_CYCLE_SECONDS. */
export function waitSeconds(text: string): number {
  const seconds = Number(text);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_CYCLE_SECONDS)
    throw new UsageError(`--wait takes whole seconds from 0 to ${MAX_CYCLE_SECONDS}`);
  return seconds;
}
