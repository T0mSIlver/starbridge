import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Ctx } from "./context";
import {
  compareVersions,
  downloadVerified,
  type InstallKind,
  latestVersion,
  platformAsset,
  RELEASE_KEY,
  RELEASES_URL,
} from "./release";
import { piPackage, piSource } from "./setup/harnesses";
import { VERSION } from "./version";

const MANAGED = {
  brew: { update: "brew upgrade starbridge", remove: "brew uninstall starbridge" },
  npm: { update: "npm i -g starbridge@latest", remove: "npm rm -g starbridge" },
};

const PLUGINS = ["starbridge@starbridge", "starbridge-mod@starbridge"];

/** Runs a command quietly; null when it is not on the PATH. */
function sh(ctx: Ctx, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { env: ctx.env as NodeJS.ProcessEnv, encoding: "utf8" });
  if (r.error) return null;
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

/** Restarts the agent's user service, if setup installed one, so it runs the new binary. */
function restartAgent(ctx: Ctx) {
  const home = ctx.env.HOME ?? homedir();
  const linux = join(home, ".config/systemd/user/starbridge-agent.service");
  const mac = join(home, "Library/LaunchAgents/run.starbridge.agent.plist");
  const r = existsSync(linux)
    ? sh(ctx, "systemctl", ["--user", "try-restart", "starbridge-agent.service"])
    : existsSync(mac)
      ? sh(ctx, "launchctl", ["kickstart", "-k", `gui/${process.getuid?.()}/run.starbridge.agent`])
      : undefined;
  if (r === undefined) return;
  ctx.out(r?.ok ? "Restarted the starbridge agent." : `Could not restart the agent: ${r?.out}`);
}

/** Updates the Claude Code plugins this machine has installed from the Starbridge marketplace. */
function updatePlugins(ctx: Ctx) {
  const list = sh(ctx, "claude", ["plugin", "list", "--json"]);
  if (!list?.ok) return;
  let ids: string[];
  try {
    ids = (JSON.parse(list.out) as { id: string }[]).map((p) => p.id);
  } catch {
    return;
  }
  for (const id of PLUGINS.filter((p) => ids.includes(p))) {
    const r = sh(ctx, "claude", ["plugin", "update", id]);
    ctx.out(r?.ok ? `Updated the ${id} plugin.` : `Could not update the ${id} plugin: ${r?.out}`);
  }
}

/** Moves an installed Starbridge Pi package to `version`'s tag, as setup does for its own. */
function movePiPackage(ctx: Ctx, version: string) {
  if (!piPackage({ ctx, home: ctx.env.HOME ?? homedir() })) return;
  const r = sh(ctx, "pi", ["install", piSource(version)]);
  if (r === null) return;
  ctx.out(
    r.ok
      ? `Moved the Starbridge Pi package to v${version}.`
      : `Could not move the Starbridge Pi package to v${version}: ${r.out}`,
  );
}

/**
 * `starbridge update`: replaces a script-installed binary with the latest release once its
 * signature and hash check out, then restarts the agent and updates the plugins and the Pi package.
 */
export async function update(
  ctx: Ctx,
  install: InstallKind,
  pubkey = RELEASE_KEY,
): Promise<number> {
  if (install.kind !== "binary") {
    ctx.out(`starbridge was installed with ${install.kind}: run ${MANAGED[install.kind].update}`);
    return 0;
  }
  const releases = ctx.env.STARBRIDGE_RELEASES_URL ?? RELEASES_URL;
  const latest = await latestVersion(releases);
  if (compareVersions(latest, VERSION) <= 0) {
    ctx.out(`starbridge ${VERSION} is up to date.`);
    return 0;
  }
  const bytes = await downloadVerified(latest, platformAsset(), { releases, pubkey });
  // Written next to the binary, then renamed over it: a running copy keeps its old inode.
  const next = join(dirname(install.path), ".starbridge.new");
  writeFileSync(next, bytes, { mode: 0o755 });
  chmodSync(next, 0o755);
  renameSync(next, install.path);
  ctx.out(`Updated starbridge ${VERSION} to ${latest}.`);
  restartAgent(ctx);
  updatePlugins(ctx);
  movePiPackage(ctx, latest);
  return 0;
}

/** Removes a script-installed binary; brew and npm installs are removed by their manager. */
export function removeBinary(ctx: Ctx, install: InstallKind): number {
  if (install.kind !== "binary") {
    ctx.out(`starbridge was installed with ${install.kind}: run ${MANAGED[install.kind].remove}`);
    return 0;
  }
  rmSync(install.path, { force: true });
  ctx.out(`Removed ${install.path}.`);
  return 0;
}
