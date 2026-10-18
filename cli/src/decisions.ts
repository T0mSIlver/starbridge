import { type Answer, type Decision, type Directory, ProtocolError } from "@starbridge/protocol";
import { Interrupted } from "./agent/client";
import { ApiError, Unreachable } from "./api";
import type { State } from "./config";
import {
  type Ctx,
  devices,
  parseDuration,
  refreshDirectory,
  type Session,
  session,
  signedHead,
  UsageError,
} from "./context";
import { buildDecision, sealWithPictures } from "./decisions/build";
import {
  answerInLine,
  askLines,
  closedError,
  delivery,
  deliveryLine,
  named,
  printAnswer,
} from "./decisions/lines";
import { poll } from "./decisions/poll";
import { RESEAL_MS } from "./decisions/reseal";
import { settleOne } from "./decisions/settle";
import { printSnooze, takeSnooze } from "./decisions/snooze";
import { type AskInput, bindSession, resolveSource } from "./decisions/source";
import { takeAnswer } from "./decisions/take";
import { dropRevokedNow } from "./decisions/trust";
import { markWaiting, postWaiting } from "./decisions/waiting";
import { loadPicture } from "./images";

export { ASK_LIMITS, buildDecision, typedBreaks } from "./decisions/build";
export {
  answerInLine,
  answerLine,
  answerPrefix,
  askLines,
  closedError,
  closedHow,
  type Delivery,
  DONE_LINE,
  delivery,
  deliveryLine,
  hooklessLine,
  MOD_SEEN_MS,
  named,
  pastTime,
  staleLine,
} from "./decisions/lines";
export { poll } from "./decisions/poll";
export { RESEAL_MS } from "./decisions/reseal";
export { pickerReason, type SettleOpts, settle } from "./decisions/settle";
export {
  acceptSnooze,
  printSnooze,
  snoozedUntil,
  snoozeLine,
  snoozeTime,
  takeSnooze,
} from "./decisions/snooze";
export { type AskInput, bindSession, resolveSource } from "./decisions/source";
export {
  ackLines,
  answers,
  deliverable,
  MAX_CYCLE_SECONDS,
  type SessionLine,
  sessionLines,
  steering,
  takeAnswer,
  takeUnseen,
  waitSeconds,
} from "./decisions/take";
export { behindBy, checkAnswer, dropRevokedNow, noteHead } from "./decisions/trust";
export { markWaiting, postWaiting, setWaiting } from "./decisions/waiting";

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
 * How long a decision's post may take, its images included: a server that takes the connection
 * and never answers would otherwise hold `ask` for ever, past SIGTERM (#1288).
 */
const POST_MS = 60_000;
/** How long the withdrawal of a decision whose post failed may take. */
const WITHDRAW_MS = 5_000;

/**
 * Seals the decision to every active device, posts it and records it in the state, so its
 * answer reaches the session that asked. Returns the decision. A post cut short is settled, as
 * the server may hold it: `elsewhere` once `answered` is aborted (a harness's picker answered
 * at the keyboard, #1913), otherwise withdrawn.
 */
export async function postDecision(
  ctx: Ctx,
  s: Session,
  input: AskInput,
  answered?: AbortSignal,
): Promise<Decision> {
  const deadline = AbortSignal.timeout(POST_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
  // Ctrl-C exits 130, as everywhere (CONTRACT.md); the deadline says what it cut.
  const cut = (e: unknown) =>
    ctx.signal?.aborted
      ? new Interrupted()
      : deadline.aborted
        ? new Unreachable(`the server did not take the question within ${POST_MS / 1000} s`)
        : e;
  let dir: Directory;
  try {
    dir = await refreshDirectory(ctx, s, signal);
  } catch (e) {
    throw cut(e);
  }
  const pictures = (input.images ?? []).map((i) =>
    typeof i === "string" ? loadPicture(i) : loadPicture(i.path, i.alt),
  );
  const to = devices(ctx, dir);
  // A new id that an earlier decision of the account already holds is refused (409); mint again.
  for (let tries = 1; ; tries++) {
    const base = {
      ...buildDecision(
        input,
        ctx,
        s.machine.name,
        to.map((d) => d.id),
      ),
      dir: signedHead(dir),
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
    let minted = false;
    ctx.store.updateState((st) => {
      // An id this machine already holds is another question's: mint again, keeping its record.
      if (st.asked[decision.id]) return;
      minted = true;
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
        ...(input.antigravity && decision.source.session ? { antigravity: input.antigravity } : {}),
        ...(input.extensionAnswers && decision.source.session ? { extensionAnswers: true } : {}),
        ...(input.held ? { held: true } : {}),
        ...(input.picker ? { picker: input.picker } : {}),
        ...(input.subagent && decision.source.session && !input.held
          ? { subagent: input.subagent }
          : {}),
        // Recorded before the post: the server may hand out its answer before it replies.
        posting: true,
      };
    });
    if (!minted) {
      if (tries < 4) continue;
      throw new Error(`could not mint a new decision id`);
    }
    const posted = () =>
      ctx.store.updateState((st) => {
        delete st.asked[decision.id]?.posting;
      });
    try {
      await s.api.postItem(input.waiting ? { ...item, quiet: true } : item, signal);
    } catch (e) {
      // Refused: the server stored nothing. Otherwise it may have stored the decision before the
      // reply was lost (#1289): withdrawn, or its card stays open on the devices and its answer
      // finds no decision here. A server that never got it refuses this, which changes nothing.
      if (e instanceof ApiError && e.status < 500)
        ctx.store.updateState((st) => {
          delete st.asked[decision.id];
        });
      if (e instanceof ApiError && e.code === "duplicate-id" && tries < 4) continue;
      if (!(e instanceof ApiError) || e.status >= 500) {
        posted();
        // Settled while it posted, its own word stands.
        const a = ctx.store.state().asked[decision.id];
        await settleOne(
          { ...ctx, signal: undefined },
          s,
          dir,
          decision.id,
          a?.settled ? a.outcome : answered?.aborted ? "elsewhere" : "withdrawn",
          false,
          a?.settled ? a.reason : undefined,
          AbortSignal.timeout(WITHDRAW_MS),
        ).catch(() => {});
      }
      throw cut(e);
    }
    posted();
    // Settled while it posted, as by `settle --all`: that notice may have reached the server
    // first and closed nothing, so it goes again now that the server holds the question.
    const a = ctx.store.state().asked[decision.id];
    if (a?.settled && !a.revoked && !ctx.store.state().answers[decision.id]) {
      await settleOne(
        { ...ctx, signal: undefined },
        s,
        dir,
        decision.id,
        a.outcome,
        false,
        a.reason,
        AbortSignal.timeout(WITHDRAW_MS),
      ).catch(() => {});
      return decision;
    }
    if (input.waiting) await markWaiting(ctx, () => postWaiting(ctx, s, decision.id, "waiting"));
    return decision;
  }
}

/**
 * Posts a decision and prints its id; with `wait`, then waits for its answer. `answered` is
 * `postDecision`'s: aborted, a post it cuts is settled elsewhere.
 */
export async function ask(
  ctx: Ctx,
  asked: AskInput,
  opts: { wait?: boolean; timeout?: string; json?: boolean; answered?: AbortSignal },
): Promise<number> {
  const s = session(ctx);
  const { input, warning } = bindSession(asked, ctx.env);
  const resolved = resolveSource(input, ctx.env, process.cwd());
  const decision = await postDecision(
    ctx,
    s,
    { ...resolved, waiting: input.waiting || opts.wait },
    opts.answered,
  );
  ctx.out(decision.id);
  if (warning) ctx.err(warning);
  // With no agent, nothing tells which sessions run a mod: the poller's lease says only that one
  // does (#537).
  if (!opts.wait) {
    const d = delivery(resolved, false, false);
    ctx.err(deliveryLine(decision.id, d));
    for (const line of askLines(resolved, d, ctx.env)) ctx.err(line);
  }
  if (input.answerIn !== undefined) ctx.err(answerInLine(decision.id));
  if (!opts.wait) return 0;
  return wait(ctx, { id: decision.id, timeout: opts.timeout, json: opts.json }, s);
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
      ctx.err(
        `No answer to ${target ? named(target, state.asked[target]?.question) : "any decision"} yet.`,
      );
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
 * Every answer the machine accepted, oldest first, from `since` (ms) on and leaving out the
 * decision ids in `known`: one whose decision was settled since stays, since it is still the
 * owner's word (#1575). Reads only: nothing is marked seen, so the session that asked still gets
 * each one.
 */
export function observedAnswers(
  st: State,
  opts: { since?: number; known?: ReadonlySet<string> } = {},
): ObservedAnswer[] {
  if (st.behind) return [];
  const lines: ObservedAnswer[] = [];
  for (const [id, { answer }] of Object.entries(st.answers)) {
    const asked = st.asked[id];
    if (!asked || (asked.answerIn && !asked.done) || opts.known?.has(id)) continue;
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
