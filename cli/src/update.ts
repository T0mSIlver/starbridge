import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Ctx } from "./context";
import { resolveCommand, spawnable } from "./platform";
import {
  compareVersions,
  DownloadError,
  downloadVerified,
  type InstallKind,
  latestVersion,
  platformAsset,
  RELEASE_KEY,
  RELEASES_URL,
  ReleaseError,
} from "./release";
import { updateCodexbar } from "./setup/codexbar";
import { piPackage, piSource } from "./setup/harnesses";
import { installedService, kind, restartTask } from "./setup/service";
import { defaults, makeSys, otherCopies } from "./setup/sys";
import { VERSION } from "./version";

const MANAGED = {
  brew: {
    update: "brew upgrade starbridge, then starbridge setup --refresh",
    remove: "brew uninstall starbridge",
  },
  npm: {
    update: "npm i -g starbridge@latest, then starbridge setup --refresh",
    remove: "npm rm -g starbridge",
  },
};

const PLUGINS = ["starbridge@starbridge", "starbridge-mod@starbridge"];

/** Runs a command quietly; null when it is not on the PATH. */
function sh(ctx: Ctx, cmd: string, args: string[]) {
  const bin = resolveCommand(ctx.env, cmd);
  if (!bin) return null;
  const start = spawnable(bin, args, ctx.env);
  const r = spawnSync(start.file, start.args, {
    env: ctx.env as NodeJS.ProcessEnv,
    encoding: "utf8",
    windowsVerbatimArguments: start.windowsVerbatimArguments,
  });
  if (r.error) return null;
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

/** Restarts the agent's user service, if setup installed one, so it runs the new binary. */
async function restartAgent(ctx: Ctx) {
  const sys = makeSys(ctx, defaults);
  if (kind(sys) === "task") {
    if (!installedService(sys)) return;
    const why = await restartTask(sys);
    ctx.out(why ? `Could not restart the agent: ${why}` : "Restarted the starbridge agent.");
    return;
  }
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
 * signature and hash check out, then restarts the agent and updates the plugins and the Pi
 * package; then moves a CodexBar that setup installed to its latest release. With `codexbar`, it
 * only installs that CodexBar release, for when the latest one breaks.
 */
export async function update(
  ctx: Ctx,
  install: InstallKind,
  pubkey = RELEASE_KEY,
  codexbar?: string,
): Promise<number> {
  const sys = makeSys(ctx, defaults);
  const configured = ctx.store.agentConfig().quota?.codexbar;
  if (codexbar !== undefined) return updateCodexbar(sys, configured, codexbar);
  // CodexBar comes from elsewhere: a download that failed here, offline or cut short, does not
  // hold it back (#617). A release that does not check out stops everything.
  let self = 0;
  try {
    await updateSelf(ctx, install, pubkey);
  } catch (e) {
    if (e instanceof ReleaseError && !(e instanceof DownloadError)) throw e;
    ctx.out(`Could not update starbridge: ${(e as Error).message}`);
    self = 1;
  }
  for (const line of await otherCopies(sys)) ctx.out(line);
  return Math.max(self, await updateCodexbar(sys, configured));
}

async function updateSelf(ctx: Ctx, install: InstallKind, pubkey: string) {
  if (install.kind !== "binary") {
    ctx.out(`starbridge was installed with ${install.kind}: run ${MANAGED[install.kind].update}`);
    return;
  }
  const releases = ctx.env.STARBRIDGE_RELEASES_URL ?? RELEASES_URL;
  const latest = await latestVersion(releases);
  if (compareVersions(latest, VERSION) <= 0) {
    ctx.out(`starbridge ${VERSION} is up to date.`);
    return;
  }
  const bytes = await downloadVerified(latest, platformAsset(), { releases, pubkey });
  // Written next to the binary, then renamed over it: a running copy keeps its old inode.
  const next = join(dirname(install.path), ".starbridge.new");
  writeFileSync(next, bytes, { mode: 0o755 });
  chmodSync(next, 0o755);
  replaceBinary(next, install.path);
  ctx.out(`Updated starbridge ${VERSION} to ${latest} in ${install.path}.`);
  // The new binary brings the files setup wrote to its version, and restarts the agent. It may
  // also install Starbridge in an agent found since setup (#750): `pi install` alone may take 5
  // minutes.
  const r = spawnSync(install.path, ["setup", "--refresh"], {
    env: ctx.env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 600_000,
  });
  for (const line of `${r.stdout ?? ""}`.split("\n").filter(Boolean)) ctx.out(line);
  if (r.status !== 0) {
    const why = `${r.stderr ?? ""}`.trim() || r.error?.message || `ended by ${r.signal}`;
    ctx.out(`Could not update the files setup wrote: ${why}`);
    await restartAgent(ctx);
  }
  updatePlugins(ctx);
  movePiPackage(ctx, latest);
}

/**
 * Moves `next` over `target`. Windows refuses to replace or delete a running `.exe` but lets it
 * be renamed, so the old one goes aside first: the agent and this process may still run it. The
 * next update removes it.
 */
export function replaceBinary(next: string, target: string, platform = process.platform) {
  if (platform !== "win32") return renameSync(next, target);
  let aside = `${target}.old`;
  try {
    rmSync(aside, { force: true });
  } catch {
    // Still running since the update before: another name.
    aside = `${target}.${process.pid}.old`;
  }
  renameSync(target, aside);
  try {
    renameSync(next, target);
  } catch (e) {
    renameSync(aside, target);
    throw e;
  }
  // This copy, and any a still-running one kept from an earlier update.
  const dir = dirname(target);
  const leftover = (f: string) => f.startsWith(`${basename(target)}.`) && f.endsWith(".old");
  for (const f of readdirSync(dir).filter(leftover))
    try {
      rmSync(join(dir, f), { force: true });
    } catch {}
}

/** Removes a script-installed binary; brew and npm installs are removed by their manager. */
export function removeBinary(ctx: Ctx, install: InstallKind): number {
  if (install.kind !== "binary") {
    ctx.out(`starbridge was installed with ${install.kind}: run ${MANAGED[install.kind].remove}`);
    return 0;
  }
  if (process.platform === "win32") return removeRunningExe(ctx, install.path);
  rmSync(install.path, { force: true });
  ctx.out(`Removed ${install.path}.`);
  return 0;
}

/**
 * Windows deletes no running `.exe`, and this one runs until uninstall returns: a detached
 * cmd.exe deletes it, and an update's leftover, two seconds after.
 */
function removeRunningExe(ctx: Ctx, path: string): number {
  if (/[%"^&]/.test(path)) {
    ctx.out(`Delete ${path} once this command returns.`);
    return 0;
  }
  const del = `ping -n 3 127.0.0.1 >nul & del /f /q "${path}" "${path}.old" "${path}.*.old"`;
  spawn(ctx.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${del}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
  ctx.out(`${path} is deleted once this command returns; if it stays, a program still runs it.`);
  return 0;
}
