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
  seal,
} from "@starbridge/protocol";
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
    source: {
      machine,
      project: input.project ?? basename(process.cwd()),
      session: input.session ?? ctx.env.CLAUDE_CODE_SESSION_ID ?? "",
    },
  };
  try {
    return parseWith(Decision, decision);
  } catch (e) {
    throw e instanceof ProtocolError ? new UsageError(`bad decision: ${e.message}`) : e;
  }
}

/** Seals the decision to every active device and posts it. Prints the decision id. */
export async function ask(
  ctx: Ctx,
  input: AskInput,
  opts: { wait?: boolean; timeout?: string; json?: boolean },
): Promise<number> {
  const s = session(ctx);
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
      ...(cursor !== undefined ? { cursor } : {}),
      ...(decision.source.session ? { session: decision.source.session } : {}),
    };
  });
  ctx.out(decision.id);
  if (!opts.wait) return 0;
  return wait(ctx, { id: decision.id, timeout: opts.timeout, json: opts.json }, s, dir);
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
function answerLine(a: Answer, question: string | undefined): string {
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
async function poll(
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

  const pick = (st = ctx.store.state()) => {
    if (target) return st.answers[target];
    return Object.values(st.answers).find((a) => !a.seen);
  };
  const report = (found: { answer: Answer }) => {
    const id = found.answer.decisionId;
    const st = ctx.store.updateState((x) => {
      const a = x.answers[id];
      if (a) a.seen = true;
    });
    printAnswer(ctx, found.answer, st.asked[id]?.question, opts.json);
    return 0;
  };

  const already = pick(state);
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
    const found = pick();
    if (found) return report(found);
  }
}

/** Keeps a `--wait` cycle under the 30 s the mod's host allows a call to run. */
const MAX_CYCLE_SECONDS = 25;

/**
 * For the Claude Code mod: hands over the answers to decisions that session `session` asked and
 * no `wait` has printed yet, one JSON line `{decisionId, line}` each, and marks them seen. With
 * `wait`, and nothing to hand over, first long-polls once for at most that many seconds from the
 * shared cursor. One cycle per call: an error exits 1, and the mod decides when to retry.
 */
export async function answers(
  ctx: Ctx,
  opts: { session?: string; wait?: string },
): Promise<number> {
  const target = opts.session;
  if (!target) throw new UsageError("answers needs --session");
  const due = (st: State, id: string) => !st.answers[id]?.seen && st.asked[id]?.session === target;
  const claim = () => {
    const handed: { decisionId: string; line: string }[] = [];
    // Writes only when there is something to hand over: the mod watches the file's time.
    const now = ctx.store.state();
    if (!Object.keys(now.answers).some((id) => due(now, id))) return 0;
    ctx.store.updateState((st) => {
      for (const [id, a] of Object.entries(st.answers)) {
        const asked = st.asked[id];
        if (!asked || !due(st, id)) continue;
        a.seen = true;
        handed.push({ decisionId: id, line: answerLine(a.answer, asked.question) });
      }
    });
    for (const h of handed) ctx.out(JSON.stringify(h));
    return handed.length;
  };
  if (claim() > 0 || opts.wait === undefined) return 0;
  const seconds = Number(opts.wait);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_CYCLE_SECONDS)
    throw new UsageError(`--wait takes whole seconds from 0 to ${MAX_CYCLE_SECONDS}`);
  const s = session(ctx);
  try {
    await poll(ctx, s, { cursor: ctx.store.state().cursor, seconds, shared: true });
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProtocolError) throw e;
    ctx.err(`starbridge: ${(e as Error).message}`);
    return 1;
  }
  claim();
  return 0;
}
