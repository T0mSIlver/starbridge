import { homedir } from "node:os";
import { type Ctx, parseDuration } from "../context";
import { dropOldPiRules, piPermissionConfig } from "../pi";
import {
  codexSkill,
  codexSkillDir,
  installCodexSkill,
  installOpencode,
  opencodeDir,
  opencodeState,
} from "../setup/harnesses";
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
  const agent = new Agent(ctx, socket, (hub) => {
    const q = new Quota(hub, quota);
    return [new Decisions(hub, (why) => q.now(why)), q, new Permissions(hub), new Runs(hub)];
  });
  return agent;
}

/** `starbridge agent`: serves until Ctrl-C or SIGTERM. */
export async function runAgent(ctx: Ctx, opts: AgentOpts): Promise<number> {
  const agent = makeAgent(ctx, opts);
  await agent.start();
  // `starbridge update` restarts the agent, so a new binary brings Codex its skill, and opencode
  // its skill and plugin, here; it also takes Pi's pre-#488 bash allow patterns out.
  const home = { ctx, home: ctx.env.HOME ?? homedir() };
  if (codexSkill(home) === "outdated") {
    try {
      installCodexSkill(home);
      agent.log(`updated the Codex skill in ${codexSkillDir(home)}`);
    } catch (e) {
      agent.log(`could not update the Codex skill: ${(e as Error).message}`);
    }
  }
  if (opencodeState(home) === "outdated") {
    try {
      installOpencode(home, true);
      agent.log(`updated the opencode skill and plugin in ${opencodeDir(home)}`);
    } catch (e) {
      agent.log(`could not update the opencode skill and plugin: ${(e as Error).message}`);
    }
  }
  try {
    if (dropOldPiRules(ctx.env))
      agent.log(
        `removed the starbridge bash patterns from ${piPermissionConfig(ctx.env)}: the Starbridge link allows the commands now (#488)`,
      );
  } catch (e) {
    agent.log(`could not remove the starbridge bash patterns: ${(e as Error).message}`);
  }
  await new Promise<void>((resolve) => {
    if (!ctx.signal || ctx.signal.aborted) return resolve();
    ctx.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  agent.log("stopping");
  await agent.stop();
  return 0;
}
