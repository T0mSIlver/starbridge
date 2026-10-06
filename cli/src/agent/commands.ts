/**
 * The CLI commands when an agent runs: the same output and exit codes as the CLI's own path to
 * the server (`withAgent` picks), with the agent holding the keys and the server connection.
 */
import type { Answer, QuotaSnapshot } from "@starbridge/protocol";
import { type Ctx, parseDuration, UsageError } from "../context";
import {
  type AskInput,
  answerLine,
  closedError,
  type Delivery,
  deliveryLine,
  EXIT_SNOOZED,
  EXIT_TIMEOUT,
  markWaiting,
  printSnooze,
  resolveSource,
  snoozeLine,
  waitSeconds,
} from "../decisions";
import { MAX_HOLD_SECONDS, type SessionEvent } from "./api";
import { type AgentClient, AgentLost, Interrupted, NoAgent } from "./client";

/** Exit code on Ctrl-C, as a shell reports SIGINT. */
const EXIT_INTERRUPTED = 130;
/** Slack past a held request's `wait` before the client gives up on the agent. */
const SLACK_MS = 15_000;
/** How long `wait` keeps trying an agent that stopped before it waits at the server (#548). */
export const RESTART_MS = 30_000;

/**
 * The agent stopped under a `wait` and did not come back: the caller waits at the server itself,
 * for what is left of the timeout (`rest`).
 */
export class AgentGone extends Error {
  constructor(readonly rest: { id?: string; session?: string; timeout?: string; json?: boolean }) {
    super("the agent stopped and did not come back");
  }
}

export async function askVia(
  ctx: Ctx,
  agent: AgentClient,
  input: AskInput,
  opts: { wait?: boolean; timeout?: string; json?: boolean },
): Promise<number> {
  const resolved = resolveSource(
    { ...input, waiting: input.waiting || opts.wait },
    ctx.env,
    process.cwd(),
  );
  const { id, delivery: d } = await agent.call<{ id: string; delivery: Delivery }>(
    "POST",
    "/v1/decisions",
    { input: resolved },
  );
  ctx.out(id);
  if (!opts.wait) ctx.err(deliveryLine(id, d));
  if (!opts.wait) return 0;
  return waitVia(ctx, agent, { id, timeout: opts.timeout, json: opts.json });
}

/** `waiting` and `working` through the agent; `waiting` says when the owner snoozed it. */
export async function waitingVia(
  agent: AgentClient,
  opts: { id?: string; state: "working" | "waiting" },
  ctx?: Ctx,
): Promise<number> {
  if (!opts.id) throw new UsageError(`${opts.state} needs a decision id`);
  const r = await agent.call<{ snoozedUntil?: string }>(
    "POST",
    `/v1/decisions/${encodeURIComponent(opts.id)}/waiting`,
    { state: opts.state },
  );
  if (ctx && r.snoozedUntil && opts.state === "waiting")
    ctx.out(
      snoozeLine(opts.id, ctx.store.state().asked[opts.id]?.question, r.snoozedUntil, ctx.now()),
    );
  return 0;
}

/** `wait` through the agent: held requests of at most MAX_HOLD_SECONDS until the deadline. */
export async function waitVia(
  ctx: Ctx,
  agent: AgentClient,
  opts: { id?: string; session?: string; timeout?: string; json?: boolean },
): Promise<number> {
  let deadline = Number.POSITIVE_INFINITY;
  if (opts.timeout) deadline = ctx.now().getTime() + parseDuration(opts.timeout);
  const rest = () => ({
    ...opts,
    ...(Number.isFinite(deadline)
      ? { timeout: `${Math.max(1, Math.ceil((deadline - ctx.now().getTime()) / 1000))}s` }
      : {}),
  });
  // A held request dies with an agent restart (#548). An answer the agent hands out is marked
  // seen only on the way to a client still listening, so asking the new agent again loses
  // nothing; one that stays away leaves the wait to the server. Retries keep to the deadline.
  const next = async (hold: number) => {
    let lost: number | undefined;
    let wait = hold;
    for (;;) {
      try {
        return await agent.call<{ answer?: Answer; question?: string; snoozedUntil?: string }>(
          "POST",
          "/v1/answers/next",
          {
            ...(opts.id ? { id: opts.id } : {}),
            ...(opts.session ? { session: opts.session } : {}),
            wait,
          },
          wait * 1000 + SLACK_MS,
          ctx.signal,
        );
      } catch (e) {
        // No agent before it ever answered: `withAgent` goes to the server at once.
        const restarted = e instanceof AgentLost || (e instanceof NoAgent && agent.answered);
        if (!restarted) throw e;
        const now = ctx.now().getTime();
        lost ??= now;
        // Past the deadline: no answer, as a held request that ended empty.
        if (now >= deadline) return {};
        if (now - lost >= RESTART_MS) throw new AgentGone(rest());
        await ctx.sleep(1000);
        if (ctx.signal?.aborted) throw new Interrupted("interrupted");
        const left = deadline - ctx.now().getTime();
        if (wait > 0) wait = Math.max(1, Math.min(wait, Math.ceil(left / 1000)));
      }
    }
  };
  let r = await next(0);
  const id = opts.id;
  // The agent's poll closes a decision a revoked device answered (#515).
  const closed = () => {
    const e = r.answer ? undefined : closedError(ctx, id);
    if (e) throw e;
  };
  closed();
  if (!r.answer && id) await markWaiting(ctx, () => waitingVia(agent, { id, state: "waiting" }));
  // Snoozed: said once, so a polling agent stops; the next `wait` waits on (#571).
  const snoozed = () => {
    if (!id || r.answer || !r.snoozedUntil) return undefined;
    printSnooze(ctx, id, r.question, r.snoozedUntil, opts.json);
    return EXIT_SNOOZED;
  };
  while (!r.answer) {
    const off = snoozed();
    if (off !== undefined) return off;
    if (ctx.signal?.aborted) return EXIT_INTERRUPTED;
    const left = deadline - ctx.now().getTime();
    if (left <= 0) {
      ctx.err(`No answer to ${opts.id ?? "any decision"} yet.`);
      return EXIT_TIMEOUT;
    }
    r = await next(Math.max(1, Math.min(MAX_HOLD_SECONDS, Math.ceil(left / 1000))));
    closed();
  }
  ctx.out(opts.json ? JSON.stringify(r.answer) : answerLine(r.answer, r.question));
  return 0;
}

/** `answers` through the agent, for the mod: the session's events as `{decisionId, ack, line}`. */
export async function answersVia(
  ctx: Ctx,
  agent: AgentClient,
  session: string,
  opts: { wait?: string; ack?: string[] },
): Promise<number> {
  const path = `/v1/sessions/${encodeURIComponent(session)}`;
  if (opts.ack) {
    await agent.call("POST", `${path}/ack`, { acks: opts.ack });
    return 0;
  }
  const wait = opts.wait === undefined ? 0 : waitSeconds(opts.wait);
  const { events } = await agent.call<{ events: SessionEvent[] }>(
    "GET",
    `${path}/events?wait=${wait}`,
    undefined,
    wait * 1000 + SLACK_MS,
    ctx.signal,
  );
  for (const e of events) {
    // The mod built for `answers` takes these fields; it skips lines without a decision id.
    ctx.out(JSON.stringify({ decisionId: e.decisionId, ack: e.ack, line: e.line }));
  }
  return 0;
}

/** One quota snapshot, run and posted by the agent. */
export async function quotaVia(agent: AgentClient, providers: string[]): Promise<QuotaSnapshot> {
  const body = providers.length > 0 ? { providers } : {};
  const r = await agent.call<{ snapshot: QuotaSnapshot }>("POST", "/v1/quota", body, 300_000);
  return r.snapshot;
}
