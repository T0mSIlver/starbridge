/**
 * `starbridge uninstall`: removes the service and Starbridge from every agent, asks the owner's devices to
 * revoke the machine, and asks before it deletes the keys. CodexBar stays.
 */
import { existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { withAgent } from "../agent/client";
import { askVia } from "../agent/commands";
import type { Ctx } from "../context";
import { type AskInput, ask, RESEAL_MS, settle } from "../decisions";
import { pathFor } from "../platform";
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
import { PATH_LINE, SERVICE } from "./integrations";
import { pruneEmpty } from "./remove";
import type { Sys } from "./sys";

export interface UninstallOpts {
  /** Also delete the config directory (keys and state) without asking. */
  purge?: boolean;
  /** How this binary was installed; removed last. Undefined keeps it. */
  install?: InstallKind;
}

/** The card uninstall posts: a machine cannot revoke itself, so it asks a device to. */
export const revokeQuestion = (name: string) => `Revoke ${name}? It was uninstalled.`;
const REVOKE_QUESTION = /^Revoke .+\? It was uninstalled\.$/;

/**
 * Withdraws the revoke cards an earlier uninstall left open (#1907). Setup calls it once the
 * server still lists this machine under the same keys: the machine is in use again, and the
 * card's advice would cut it off. Each uninstall and setup again would otherwise add one more.
 */
export async function withdrawRevokeCards(ctx: Ctx): Promise<void> {
  const st = ctx.store.state();
  const now = ctx.now().getTime();
  // As `settle --all` picks them: a withdrawal whose notice failed is posted again (#584).
  const open = Object.entries(st.asked).filter(
    ([id, a]) =>
      (!a.settled || a.unposted) &&
      !a.revoked &&
      !st.answers[id] &&
      a.project === "starbridge" &&
      REVOKE_QUESTION.test(a.question) &&
      // Older ones the server no longer holds.
      now - Date.parse(a.askedAt) < RESEAL_MS,
  );
  const quiet = { ...ctx, out: () => {}, err: () => {} };
  for (const [id, { question }] of open) {
    try {
      await settle(quiet, { id, outcome: "withdrawn", reason: "Set up again on this machine" });
      ctx.out(`✓ Withdrew "${question}": this machine is set up again`);
    } catch (e) {
      ctx.out(`✗ Could not withdraw "${question}": ${(e as Error).message}`);
    }
  }
}

export async function uninstall(sys: Sys, opts: UninstallOpts): Promise<number> {
  const { ctx, prompt } = sys;
  const machine = ctx.store.machine();

  // First, while the keys and the agent still work: a machine signs no directory entries, so
  // only a device can revoke it.
  if (machine) {
    const input: AskInput = {
      question: revokeQuestion(machine.name),
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

  const service = await SERVICE.remove(sys);
  for (const line of service.lines) ctx.out(line);
  const { stopped } = service;

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
  // The binary goes last, and only once nothing runs it any more; the PATH line with it.
  if (opts.install && stopped) {
    if (opts.install.kind === "binary")
      for (const line of PATH_LINE.remove(sys, pathFor(sys.platform).dirname(opts.install.path)))
        ctx.out(line);
    removeBinary(ctx, opts.install);
    // install.sh made ~/.local/bin when there was none (#2098); Windows deletes the binary later.
    // The binary's path is a real path, and HOME may run through a link, as /var does on macOS
    // (#2134), so the two compare as real paths.
    const bin = join(sys.home, ".local", "bin");
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    if (
      sys.platform !== "win32" &&
      opts.install.kind === "binary" &&
      dirname(opts.install.path) === real(bin)
    )
      pruneEmpty(bin, join(sys.home, ".local"));
  }
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
