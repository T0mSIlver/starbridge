/**
 * `starbridge uninstall`: removes the service and the plugins, asks the owner's devices to
 * revoke the machine, and asks before it deletes the keys. CodexBar stays.
 */
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withAgent } from "../agent/client";
import { askVia } from "../agent/commands";
import { type AskInput, ask } from "../decisions";
import { piPermissionConfig, removePiEntries } from "../pi";
import type { InstallKind } from "../release";
import { removeBinary } from "../update";
import { findCodexbar } from "./codexbar";
import {
  codexRulePath,
  codexSkillDir,
  hasPi,
  piPackage,
  removeCodexRule,
  removeCodexSkill,
  removePiPackage,
} from "./harnesses";
import {
  hasClaude,
  legacyInstalls,
  pluginState,
  removeAllowRules,
  removePlugins,
  settingsPath,
} from "./plugins";
import { legacyUnits, removeLegacy, removeService } from "./service";
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
      default: "Keep it",
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
  for (const unit of legacyUnits(sys))
    if (await prompt.confirm(`Also stop and remove ${unit.name} (starbridge quota push)?`, true)) {
      try {
        await removeLegacy(sys, unit);
        ctx.out(`Removed ${unit.path}.`);
      } catch (e) {
        stopped = false;
        ctx.out(`Could not stop ${unit.name}: ${(e as Error).message}`);
      }
    }

  if (hasClaude(sys)) {
    const state = await pluginState(sys);
    if (state) for (const line of await removePlugins(sys, state)) ctx.out(line);
    else
      ctx.out(
        "`claude plugin list` failed: remove the Starbridge plugins with `claude plugin uninstall`.",
      );
    if (removeAllowRules(sys))
      ctx.out(`Removed the starbridge allow rules from ${settingsPath(sys)}.`);
    for (const old of legacyInstalls(sys))
      if (await prompt.confirm(`Also remove ${old.what}?`, true)) {
        old.remove();
        ctx.out(`Removed ${old.what}.`);
      }
  }

  if (removeCodexSkill(sys)) ctx.out(`Removed ${codexSkillDir(sys)}.`);
  if (removeCodexRule(sys)) ctx.out(`Removed ${codexRulePath(sys)}.`);
  const piSource = hasPi(sys) ? piPackage(sys) : undefined;
  if (piSource)
    try {
      await removePiPackage(sys, piSource);
      ctx.out("Removed the Starbridge Pi package.");
    } catch (e) {
      ctx.out(`Could not remove the Pi package: ${(e as Error).message}`);
    }

  const piConfig = piPermissionConfig(ctx.env);
  if (removePiEntries(ctx.env)) ctx.out(`Removed Starbridge's entries from ${piConfig}.`);

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
