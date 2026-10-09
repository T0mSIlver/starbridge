import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { type Ctx, parseDuration } from "../context";
import { refreshFiles } from "../setup/harnesses";
import { socketPath } from "./api";
import { Decisions } from "./decisions";
import { Permissions } from "./permissions";
import { Presence } from "./presence";
import { Quota } from "./quota";
import { Runs } from "./runs";
import { Agent } from "./server";

export interface AgentOpts {
  providers?: string[];
  interval?: string;
  codexbar?: string;
  noQuota?: boolean;
  socket?: string;
  /** Appends the log to this file instead of stderr, which a Windows task has nowhere to show. */
  log?: string;
}

/** Builds the agent with every feature, from `agent.json` and the flags. Not started. */
export function makeAgent(ctx: Ctx, opts: AgentOpts = {}): Agent {
  const file = ctx.store.agentConfig().quota ?? {};
  const providers = opts.noQuota ? [] : (opts.providers ?? file.providers ?? []);
  const codexbar = opts.codexbar ?? file.codexbar;
  const intervalMs = parseDuration(opts.interval ?? file.interval ?? "5m");
  const socket = opts.socket ?? socketPath(ctx.env, ctx.store.dir);
  const quota = { providers, intervalMs, ...(codexbar ? { codexbar } : {}) };
  const agent = new Agent(ctx, socket, (hub) => {
    const q = new Quota(hub, quota);
    const presence = new Presence(hub);
    return [
      new Decisions(hub, (why) => q.now(why)),
      q,
      new Permissions(hub, () => presence.present()),
      new Runs(hub),
      presence,
    ];
  });
  return agent;
}

/** `starbridge agent`: serves until Ctrl-C or SIGTERM. */
export async function runAgent(ctx: Ctx, opts: AgentOpts): Promise<number> {
  if (opts.log) {
    const file = opts.log;
    mkdirSync(dirname(file), { recursive: true });
    ctx = { ...ctx, err: (line) => appendFileSync(file, `${line}\n`) };
  }
  // Closing the console window a Windows task runs in sends SIGHUP, and Ctrl-Break SIGBREAK:
  // both stop the agent as SIGTERM does, so its port file goes with it (#570). Caught before the
  // agent writes the file: until then either signal would end it and leave the file behind.
  const hangups = ["SIGHUP", "SIGBREAK"] as const;
  let onHangup = () => {};
  const hungUp = new Promise<void>((resolve) => {
    onHangup = resolve;
  });
  for (const s of hangups) process.on(s, onHangup);
  try {
    const agent = makeAgent(ctx, opts);
    await agent.start();
    // A new binary brings Codex and opencode their files here too, after a brew or npm upgrade.
    for (const line of refreshFiles({ ctx, home: ctx.env.HOME ?? homedir() })) agent.log(line);
    await Promise.race([
      hungUp,
      new Promise<void>((resolve) => {
        if (!ctx.signal || ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    agent.log("stopping");
    await agent.stop();
  } finally {
    for (const s of hangups) process.off(s, onHangup);
  }
  return 0;
}
