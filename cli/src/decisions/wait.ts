import { type Answer, type Directory, ProtocolError } from "@starbridge/protocol";
import { type Ctx, parseDuration, type Session, session, UsageError } from "../context";
import { closedError, named, printAnswer } from "./lines";
import { poll } from "./poll";
import { printSnooze, takeSnooze } from "./snooze";
import { takeAnswer } from "./take";
import { dropRevokedNow } from "./trust";
import { markWaiting, postWaiting } from "./waiting";

/** Exit code when nobody answered before `--timeout`. */
export const EXIT_TIMEOUT = 2;
/** `wait <id>`'s exit code when the owner snoozed the decision (#571): no answer before then. */
export const EXIT_SNOOZED = 3;
/** Exit code on Ctrl-C, as a shell reports SIGINT. */
export const EXIT_INTERRUPTED = 130;
/** The server holds a long-poll at most this long (PROTOCOL.md). */
const MAX_POLL_SECONDS = 300;
/** Pause before retrying after a network or server error. */
export const RETRY_MS = 5_000;
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
