/** Setup's Claude Code step: the Starbridge marketplace and its two plugins, at user scope. */
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import market from "../../../.claude-plugin/marketplace.json" with { type: "json" };
import { replaceFile } from "../replace";
import { COMMIT, VERSION } from "../version";
import { failure, run, type Sys, which } from "./sys";

const MARKETPLACE = "starbridge";
/** The repository's own marketplace, which setup before #1768 added and now replaces. */
const MARKETPLACE_SOURCE = "T0mSIlver/starbridge";
export const PLUGINS = [`starbridge@${MARKETPLACE}`, `starbridge-mod@${MARKETPLACE}`];

/**
 * The folder setup writes the marketplace into, from this binary: Claude Code installs the plugins
 * from it, never from the repository's default branch, which a push changes for every machine.
 */
export function marketplaceDir(sys: Home): string {
  return join(claudeDir(sys), "starbridge-marketplace");
}

const marketplaceFile = (sys: Sys) =>
  join(marketplaceDir(sys), ".claude-plugin", "marketplace.json");

/**
 * The marketplace this binary installs from: the repository's, with each plugin at this release's
 * commit, which the signed binary carries, so the plugins are the code the signature covers; a tag
 * can move. A build from source has no commit and takes its version's tag.
 */
export function marketplaceText(version = VERSION, commit = COMMIT): string {
  const plugins = market.plugins.map((p) => ({
    ...p,
    source: { ...p.source, ref: `v${version}`, ...(commit ? { sha: commit } : {}) },
  }));
  return `${JSON.stringify({ ...market, plugins }, null, 2)}\n`;
}

/** Whether the marketplace folder holds this binary's marketplace. */
function marketplaceCurrent(sys: Sys): boolean {
  try {
    return readFileSync(marketplaceFile(sys), "utf8") === marketplaceText();
  } catch {
    return false;
  }
}

function writeMarketplace(sys: Sys) {
  mkdirSync(dirname(marketplaceFile(sys)), { recursive: true });
  writeFileSync(marketplaceFile(sys), marketplaceText());
}

/** Removes the marketplace file setup wrote, then its folders when left empty. */
function removeMarketplaceFiles(sys: Sys) {
  rmSync(marketplaceFile(sys), { force: true });
  for (const dir of [dirname(marketplaceFile(sys)), marketplaceDir(sys)])
    try {
      rmdirSync(dir);
    } catch {}
}

export function hasClaude(sys: Sys): boolean {
  return which(sys.ctx.env, "claude") !== undefined;
}

export type Home = Pick<Sys, "ctx" | "home">;

export function claudeDir(sys: Home) {
  return sys.ctx.env.CLAUDE_CONFIG_DIR || join(sys.home, ".claude");
}

/**
 * Runs from the home directory, so a repository's `.claude/settings.json` around the current
 * directory neither shows its marketplaces to setup nor gets edited by it (#762).
 */
const claude = (sys: Sys, ...args: string[]) =>
  run(sys, "claude", args, { timeoutMs: 180_000, cwd: sys.home });

/** The list, or why `claude <args> --json` gave none. */
async function listJson<T>(sys: Sys, ...args: string[]): Promise<T[] | string> {
  const r = await claude(sys, ...args, "--json");
  const why = `\`claude ${args.join(" ")} --json\` failed`;
  if (r?.code !== 0) return `${why} (${failure(r)})`;
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return Array.isArray(v) ? (v as T[]) : `${why} (not a list)`;
  } catch {
    return `${why} (not JSON)`;
  }
}

/**
 * The oldest Claude Code Starbridge works with: the first that runs its mod (docs/tell-your-agents.md), which
 * also has the `--json` plugin listings setup reads (#620).
 */
const MIN_CLAUDE = "2.1.287";

/** `claude --version`'s number, such as "2.1.289", or undefined when it gives none. */
async function claudeVersion(sys: Sys): Promise<string | undefined> {
  const r = await claude(sys, "--version");
  return r?.code === 0 ? /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] : undefined;
}

const older = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++)
    if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) < (y?.[i] ?? 0);
  return false;
};

/**
 * Says so when this Claude Code is older than MIN_CLAUDE, with how to update it; with `unknown`,
 * also when its version cannot be read.
 */
export async function claudeTooOld(sys: Sys, unknown = false): Promise<string | undefined> {
  const v = await claudeVersion(sys);
  if (v && older(v, MIN_CLAUDE))
    return `Claude Code ${v} is older than ${MIN_CLAUDE}, the oldest Starbridge works with: \`claude update\` updates it`;
  if (!v && unknown) return `Starbridge needs Claude Code ${MIN_CLAUDE} or newer`;
  return undefined;
}

export interface PluginState {
  marketplace: boolean;
  /** The marketplace is the folder setup writes, so the plugins are at the release's commit. */
  pinned?: boolean;
  /**
   * Where a marketplace named `starbridge` comes from, when it is neither that folder nor this
   * repository.
   */
  foreign?: string;
  /** Installed at user scope, with whether each is enabled and its folder. */
  plugins: Record<string, { enabled: boolean; version?: string; installPath?: string } | undefined>;
}

/** The state, or why `claude` gave none: missing, too old or not answering. */
export async function pluginState(sys: Sys): Promise<PluginState | string> {
  const markets = await listJson<Market>(sys, "plugin", "marketplace", "list");
  const installed = await listJson<{
    id: string;
    scope: string;
    enabled: boolean;
    version?: string;
    installPath?: string;
  }>(sys, "plugin", "list");
  if (typeof markets === "string" || typeof installed === "string") {
    const old = await claudeTooOld(sys, true);
    return `${typeof markets === "string" ? markets : installed}${old ? `. ${old}` : ""}`;
  }
  const plugins: PluginState["plugins"] = {};
  for (const id of PLUGINS) {
    const p = installed.find((x) => x.id === id && x.scope === "user");
    plugins[id] = p
      ? {
          enabled: p.enabled,
          ...(p.version ? { version: p.version } : {}),
          ...(p.installPath ? { installPath: p.installPath } : {}),
        }
      : undefined;
  }
  const ours = markets.find((m) => m.name === MARKETPLACE);
  const from = ours && marketSource(ours);
  const pinned =
    ours?.source === "directory" &&
    !!ours.path &&
    resolve(ours.path) === resolve(marketplaceDir(sys));
  return {
    marketplace: ours !== undefined,
    ...(pinned ? { pinned } : {}),
    ...(ours && !pinned && from !== MARKETPLACE_SOURCE.toLowerCase()
      ? { foreign: from ?? JSON.stringify(ours) }
      : {}),
    plugins,
  };
}

interface Market {
  name: string;
  source?: string;
  repo?: string;
  url?: string;
  path?: string;
}

/** `owner/repo` for a GitHub marketplace, lowercased; else its URL or path. */
function marketSource(m: Market): string | undefined {
  if (m.source === "github" && m.repo) return m.repo.toLowerCase();
  const gh = /^(?:https:\/\/|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(m.url ?? "");
  if (gh) return (gh[1] as string).toLowerCase();
  return m.url ?? m.path;
}

/**
 * Why setup must not install from the `starbridge` marketplace Claude Code knows: any marketplace
 * can take that name, and its plugins would run hooks on every session.
 */
export function foreignMarketplace(state: PluginState): string | undefined {
  return state.foreign
    ? `the marketplace named ${MARKETPLACE} comes from ${state.foreign}, not ${MARKETPLACE_SOURCE}: remove it with \`claude plugin marketplace remove ${MARKETPLACE}\`, then rerun setup`
    : undefined;
}

/** Whether the plugins need `installPlugins`: one is missing, or not at this release's commit. */
export function pluginsStale(sys: Sys, state: PluginState): boolean {
  return !state.pinned || !marketplaceCurrent(sys) || PLUGINS.some((p) => !state.plugins[p]);
}

/**
 * Writes this binary's marketplace, adds it, and installs or updates the plugins from it. The
 * repository's marketplace that earlier setups added goes first, with its plugins. Returns one
 * line per thing done.
 */
export async function installPlugins(sys: Sys, state: PluginState): Promise<string[]> {
  const foreign = foreignMarketplace(state);
  if (foreign) throw new Error(foreign);
  const changed = !marketplaceCurrent(sys);
  writeMarketplace(sys);
  try {
    return await fromMarketplace(sys, state, changed);
  } catch (e) {
    // Not current until every step went through, so the next setup or refresh tries again.
    if (changed) rmSync(marketplaceFile(sys), { force: true });
    throw e;
  }
}

async function fromMarketplace(sys: Sys, state: PluginState, changed: boolean): Promise<string[]> {
  const done: string[] = [];
  let plugins = state.plugins;
  // What the owner turned off stays off once the plugins come back from the new marketplace.
  const disabled = state.pinned ? [] : PLUGINS.filter((id) => plugins[id]?.enabled === false);
  if (state.marketplace && !state.pinned) {
    // Removing a marketplace uninstalls its plugins.
    const r = await claude(sys, "plugin", "marketplace", "remove", MARKETPLACE);
    if (r?.code !== 0)
      throw new Error(`claude plugin marketplace remove ${MARKETPLACE}: ${failure(r)}`);
    plugins = {};
  }
  const dir = marketplaceDir(sys);
  if (!state.pinned) {
    const r = await claude(sys, "plugin", "marketplace", "add", dir, "--scope", "user");
    if (r?.code !== 0) throw new Error(`claude plugin marketplace add ${dir}: ${failure(r)}`);
    done.push(`Added the ${MARKETPLACE} marketplace.`);
  } else if (changed) {
    const r = await claude(sys, "plugin", "marketplace", "update", MARKETPLACE);
    if (r?.code !== 0)
      throw new Error(`claude plugin marketplace update ${MARKETPLACE}: ${failure(r)}`);
  }
  for (const id of PLUGINS) {
    const update = !!plugins[id];
    if (update && !changed) continue;
    const r = await claude(sys, "plugin", update ? "update" : "install", id, "--scope", "user");
    if (r?.code !== 0)
      throw new Error(`claude plugin ${update ? "update" : "install"} ${id}: ${failure(r)}`);
    done.push(`${update ? "Updated" : "Installed"} the ${id} plugin.`);
  }
  for (const id of disabled) {
    const r = await claude(sys, "plugin", "disable", id, "--scope", "user");
    if (r?.code !== 0) throw new Error(`claude plugin disable ${id}: ${failure(r)}`);
  }
  return done;
}

/**
 * Uninstalls both plugins and the marketplace. Leaves a marketplace from another
 * source and its plugins alone, since setup never installs from one (#762).
 */
export async function removePlugins(sys: Sys, state: PluginState): Promise<string[]> {
  if (state.foreign)
    return [`Left the ${MARKETPLACE} marketplace from ${state.foreign} and its plugins alone.`];
  const done: string[] = [];
  for (const id of PLUGINS) {
    if (!state.plugins[id]) continue;
    const r = await claude(sys, "plugin", "uninstall", id, "--scope", "user");
    done.push(
      r?.code === 0 ? `Uninstalled the ${id} plugin.` : `Could not uninstall ${id}: ${failure(r)}`,
    );
  }
  if (state.marketplace) {
    // No `--scope user`: with it, Claude Code drops the declaration but keeps the marketplace in
    // its known list. Run from home, every scope is only the files under ~/.claude.
    const r = await claude(sys, "plugin", "marketplace", "remove", MARKETPLACE);
    done.push(
      r?.code === 0
        ? `Removed the ${MARKETPLACE} marketplace.`
        : `Could not remove the marketplace: ${failure(r)}`,
    );
  }
  removeMarketplaceFiles(sys);
  return done;
}

type Settings = Record<string, unknown> & {
  env?: Record<string, string>;
  permissions?: Record<string, unknown> & { allow?: unknown };
  extraKnownMarketplaces?: Record<string, Record<string, unknown>>;
};

export function settingsPath(sys: Home) {
  return join(claudeDir(sys), "settings.json");
}

/** User settings; undefined when the file is missing, does not parse or is no object (#1335). */
export function readSettings(sys: Home): Settings | undefined {
  try {
    const v = JSON.parse(readFileSync(settingsPath(sys), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Settings) : undefined;
  } catch {
    return undefined;
  }
}

export function writeSettings(sys: Home, s: Settings) {
  replaceFile(settingsPath(sys), `${JSON.stringify(s, null, 2)}\n`);
}

/** Whether background auto-update is on for the marketplace; undefined when it is not declared. */
export function autoUpdate(sys: Sys): boolean | undefined {
  const entry = readSettings(sys)?.extraKnownMarketplaces?.[MARKETPLACE];
  return entry ? entry.autoUpdate === true : undefined;
}

/** Turns on auto-update on the marketplace's entry in user settings. False when there is none. */
export function enableAutoUpdate(sys: Sys): boolean {
  const s = readSettings(sys);
  const entry = s?.extraKnownMarketplaces?.[MARKETPLACE];
  if (!s || !entry) return false;
  entry.autoUpdate = true;
  writeSettings(sys, s);
  return true;
}
