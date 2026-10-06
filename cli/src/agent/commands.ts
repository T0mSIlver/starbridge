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
  EXIT_TIMEOUT,
  markWaiting,
  resolveSource,
  waitSeconds,
} from "../decisions";
import { MAX_HOLD_SECONDS, type SessionEvent } from "./api";
import type { AgentClient } from "./client";

/** Exit code on Ctrl-C, as a shell reports SIGINT. */
const EXIT_INTERRUPTED = 130;
/** Slack past a held request's `wait` before the client gives up on the agent. */
const SLACK_MS = 15_000;

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

/** `waiting` and `working` through the agent. */
export async function waitingVia(
  agent: AgentClient,
  opts: { id?: string; state: "working" | "waiting" },
): Promise<number> {
  if (!opts.id) throw new UsageError(`${opts.state} needs a decision id`);
  await agent.call("POST", `/v1/decisions/${encodeURIComponent(opts.id)}/waiting`, {
    state: opts.state,
  });
  return 0;
}

/** `wait` through the agent: held requests of at most MAX_HOLD_SECONDS until the deadline. */
export async function waitVia(
  ctx: Ctx,
  agent: AgentClient,
  opts: { id?: string; session?: string; timeout?: string; json?: boolean },
): Promise<number> {
  const next = (wait: number) =>
    agent.call<{ answer?: Answer; question?: string }>(
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
  let r = await next(0);
  const id = opts.id;
  // The agent's poll closes a decision a revoked device answered (#515).
  const closed = () => {
    const e = r.answer ? undefined : closedError(ctx, id);
    if (e) throw e;
  };
  closed();
  if (!r.answer && id) await markWaiting(ctx, () => waitingVia(agent, { id, state: "waiting" }));
  let deadline = Number.POSITIVE_INFINITY;
  if (opts.timeout) deadline = ctx.now().getTime() + parseDuration(opts.timeout);
  while (!r.answer) {
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
