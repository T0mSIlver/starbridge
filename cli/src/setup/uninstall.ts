/**
 * `starbridge uninstall`: removes the service and Starbridge from every agent, asks the owner's devices to
 * revoke the machine, and asks before it deletes the keys. CodexBar stays.
 */
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withAgent } from "../agent/client";
import { askVia } from "../agent/commands";
import { type AskInput, ask } from "../decisions";
import type { InstallKind } from "../release";
import { removeBinary } from "../update";
import {
  AGENT_IDS,
  AGENTS,
  type AgentId,
  found,
  removeAgent,
  removedAgents,
  setRemoved,
} from "./agents";
import { findCodexbar } from "./codexbar";
import { removeService } from "./service";
import type { Sys } from "./sys";

export interface UninstallOpts {
  /** Also delete the config directory (keys and state) without asking. */
  purge?: boolean;
  /** How this binary was installed; removed last. Undefined keeps it. */
  install?: InstallKind;
}

export async function uninstall(sys: Sys, opts: UninstallOpts): Promise<number> {
  const { ctx, prompt } = sys;
  const machine = ctx.store.machine();

  // First, while the keys and the agent still work: a machine signs no directory entries, so
  // only a device can revoke it.
  if (machine) {
    const input: AskInput = {
      question: `Revoke ${machine.name}? It was uninstalled.`,
      context: `\`starbridge uninstall\` ran on ${machine.name}. A machine cannot revoke itself: revoke it under Devices so its keys no longer receive your decisions and quotas.`,
      options: ["I revoked it", "Keep it"],
      project: "starbridge",
      session: "",
    };
    // The id and the hint `ask` prints are for agents, not for someone uninstalling.
    const quiet = { ...ctx, out: () => {}, err: () => {} };
    try {
      await withAgent(
        quiet,
        (agent) => askVia(quiet, agent, input, {}),
        () => ask(quiet, input, {}),
      );
      ctx.out(`Posted "${input.question}" to your devices.`);
    } catch (e) {
      ctx.out(`Could not post the revoke reminder: ${(e as Error).message}`);
    }
  }

  let stopped = true;
  try {
    ctx.out(
      (await removeService(sys))
        ? "Stopped and removed the agent service."
        : "No agent service installed.",
    );
  } catch (e) {
    stopped = false;
    ctx.out(`Could not stop the agent service, so it stays: ${(e as Error).message}`);
  }

  for (const id of AGENT_IDS) for (const line of await removeAgent(sys, id)) ctx.out(line);
  // A later setup installs Starbridge in every agent again.
  for (const id of removedAgents(ctx)) setRemoved(ctx, id, false);

  const dir = ctx.store.dir;
  if (!stopped && existsSync(dir)) {
    ctx.out(`Kept ${dir}: a service still uses it. Stop it, then rerun \`starbridge uninstall\`.`);
  } else if (existsSync(dir)) {
    if (
      opts.purge ||
      (await prompt.confirm(`Delete ${dir} (this machine's keys and state)?`, false))
    ) {
      rmSync(dir, { recursive: true, force: true });
      ctx.out(`Deleted ${dir}.`);
    } else ctx.out(`Kept ${dir}: \`starbridge setup\` reuses it.`);
  }

  if (machine) ctx.out(`Revoke "${machine.name}" under Devices in the Starbridge app or web page.`);
  const cb = findCodexbar(sys);
  if (cb) {
    const opt = join(sys.home, ".local/opt/codexbar");
    const how = cb.inApp
      ? "brew uninstall --cask codexbar (or drag CodexBar.app to the Bin)"
      : realpathSync(cb.path).startsWith(opt)
        ? `rm -rf ${opt} ${join(sys.home, ".local/bin/codexbar")}`
        : "your package manager";
    ctx.out(`CodexBar stays installed (${cb.path}); remove it with ${how}.`);
  }
  // The binary goes last, and only once nothing runs it any more.
  if (opts.install && stopped) removeBinary(ctx, opts.install);
  return stopped ? 0 : 1;
}

/**
 * `uninstall --agent <name>`: Starbridge out of that agent only (#750). Setup and refresh leave
 * it out until `setup --agent <name>` brings it back.
 */
export async function uninstallAgent(sys: Sys, id: AgentId): Promise<number> {
  const { ctx } = sys;
  const done = await removeAgent(sys, id);
  setRemoved(ctx, id, true);
  for (const line of done) ctx.out(line);
  if (done.length === 0)
    ctx.out(
      `Starbridge was not in ${AGENTS[id]}${found(sys, id) ? "" : ", which is not installed"}.`,
    );
  ctx.out(`Setup leaves ${AGENTS[id]} out from now on. To bring it back:`);
  ctx.out(`  starbridge setup --agent ${id}`);
  return done.some((l) => l.startsWith("Could not")) ? 1 : 0;
}
