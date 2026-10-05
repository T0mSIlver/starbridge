import { type Ctx, parseDuration } from "../context";
import { socketPath } from "./api";
import { Decisions } from "./decisions";
import { Permissions } from "./permissions";
import { Quota } from "./quota";
import { Runs } from "./runs";
import { Agent } from "./server";

export interface AgentOpts {
  providers?: string[];
  interval?: string;
  codexbar?: string;
  noQuota?: boolean;
  socket?: string;
}

/** Builds the agent with every feature, from `agent.json` and the flags. Not started. */
export function makeAgent(ctx: Ctx, opts: AgentOpts = {}): Agent {
  const file = ctx.store.agentConfig().quota ?? {};
  const providers = opts.noQuota ? [] : (opts.providers ?? file.providers ?? []);
  const codexbar = opts.codexbar ?? file.codexbar;
  const intervalMs = parseDuration(opts.interval ?? file.interval ?? "5m");
  const socket = opts.socket ?? socketPath(ctx.env, ctx.store.dir);
  const quota = { providers, intervalMs, ...(codexbar ? { codexbar } : {}) };
  const agent = new Agent(ctx, socket, (hub) => [
    new Decisions(hub),
    new Quota(hub, quota),
    new Permissions(hub),
    new Runs(hub),
  ]);
  return agent;
}

/** `starbridge agent`: serves until Ctrl-C or SIGTERM. */
export async function runAgent(ctx: Ctx, opts: AgentOpts): Promise<number> {
  const agent = makeAgent(ctx, opts);
  await agent.start();
  await new Promise<void>((resolve) => {
    if (!ctx.signal || ctx.signal.aborted) return resolve();
    ctx.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  agent.log("stopping");
  await agent.stop();
  return 0;
}
