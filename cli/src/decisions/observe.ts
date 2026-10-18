import { type Directory, ProtocolError } from "@starbridge/protocol";
import type { State } from "../config";
import { type Ctx, parseDuration, session, UsageError } from "../context";
import { poll } from "./poll";
import { RESEAL_MS } from "./reseal";
import { EXIT_INTERRUPTED, RETRY_MS } from "./wait";

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
