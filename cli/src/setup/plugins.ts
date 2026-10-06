/** Setup's Claude Code step: the Starbridge marketplace and its two plugins, at user scope. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failure, run, type Sys, which } from "./sys";

export const MARKETPLACE = "starbridge";
export const MARKETPLACE_SOURCE = "T0mSIlver/starbridge";
export const PLUGINS = [`starbridge@${MARKETPLACE}`, `starbridge-mod@${MARKETPLACE}`];

export function hasClaude(sys: Sys): boolean {
  return which(sys.ctx.env, "claude") !== undefined;
}

function claudeDir(sys: Sys) {
  return sys.ctx.env.CLAUDE_CONFIG_DIR || join(sys.home, ".claude");
}

const claude = (sys: Sys, ...args: string[]) => run(sys, "claude", args, { timeoutMs: 180_000 });

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
export const MIN_CLAUDE = "2.1.287";

/** `claude --version`'s number, such as "2.1.289", or undefined when it gives none. */
export async function claudeVersion(sys: Sys): Promise<string | undefined> {
  const r = await claude(sys, "--version");
  return r?.code === 0 ? /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] : undefined;
}

const older = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++)
    if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) < (y?.[i] ?? 0);
  return false;
};

/** Says so when this Claude Code is older than MIN_CLAUDE, with how to update it. */
export async function claudeTooOld(sys: Sys): Promise<string | undefined> {
  const v = await claudeVersion(sys);
  if (v && older(v, MIN_CLAUDE))
    return `Claude Code ${v} is older than ${MIN_CLAUDE}, the oldest Starbridge works with: \`claude update\` updates it`;
  return undefined;
}

export interface PluginState {
  marketplace: boolean;
  /** Where a marketplace named `starbridge` comes from, when it is not this repository. */
  foreign?: string;
  /** Installed at user scope, with whether each is enabled. */
  plugins: Record<string, { enabled: boolean; version?: string } | undefined>;
}

/** The state, or why `claude` gave none: missing, too old or not answering. */
export async function pluginState(sys: Sys): Promise<PluginState | string> {
  const markets = await listJson<Market>(sys, "plugin", "marketplace", "list");
  const installed = await listJson<{
    id: string;
    scope: string;
    enabled: boolean;
    version?: string;
  }>(sys, "plugin", "list");
  if (typeof markets === "string" || typeof installed === "string")
    return `${typeof markets === "string" ? markets : installed}. ${(await claudeTooOld(sys)) ?? `Starbridge needs Claude Code ${MIN_CLAUDE} or newer`}`;
  const plugins: PluginState["plugins"] = {};
  for (const id of PLUGINS) {
    const p = installed.find((x) => x.id === id && x.scope === "user");
    plugins[id] = p
      ? { enabled: p.enabled, ...(p.version ? { version: p.version } : {}) }
      : undefined;
  }
  const ours = markets.find((m) => m.name === MARKETPLACE);
  const from = ours && marketSource(ours);
  return {
    marketplace: ours !== undefined,
    ...(ours && from !== MARKETPLACE_SOURCE.toLowerCase()
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

/** Adds the marketplace and installs what is missing. Returns one line per thing done. */
export async function installPlugins(sys: Sys, state: PluginState): Promise<string[]> {
  const foreign = foreignMarketplace(state);
  if (foreign) throw new Error(foreign);
  const done: string[] = [];
  if (!state.marketplace) {
    const r = await claude(sys, "plugin", "marketplace", "add", MARKETPLACE_SOURCE);
    if (r?.code !== 0)
      throw new Error(`claude plugin marketplace add ${MARKETPLACE_SOURCE}: ${failure(r)}`);
    done.push(`Added the ${MARKETPLACE} marketplace.`);
  }
  for (const id of PLUGINS) {
    if (state.plugins[id]) continue;
    const r = await claude(sys, "plugin", "install", id, "--scope", "user");
    if (r?.code !== 0) throw new Error(`claude plugin install ${id}: ${failure(r)}`);
    done.push(`Installed the ${id} plugin.`);
  }
  return done;
}

/** Uninstalls both plugins and the marketplace. */
export async function removePlugins(sys: Sys, state: PluginState): Promise<string[]> {
  const done: string[] = [];
  for (const id of PLUGINS) {
    if (!state.plugins[id]) continue;
    const r = await claude(sys, "plugin", "uninstall", id, "--scope", "user");
    done.push(
      r?.code === 0 ? `Uninstalled the ${id} plugin.` : `Could not uninstall ${id}: ${failure(r)}`,
    );
  }
  if (state.marketplace) {
    const r = await claude(sys, "plugin", "marketplace", "remove", MARKETPLACE);
    done.push(
      r?.code === 0
        ? `Removed the ${MARKETPLACE} marketplace.`
        : `Could not remove the marketplace: ${failure(r)}`,
    );
  }
  return done;
}

type Settings = Record<string, unknown> & {
  env?: Record<string, string>;
  permissions?: Record<string, unknown> & { allow?: unknown };
  extraKnownMarketplaces?: Record<string, Record<string, unknown>>;
};

export function settingsPath(sys: Sys) {
  return join(claudeDir(sys), "settings.json");
}

function readSettings(sys: Sys): Settings | undefined {
  try {
    return JSON.parse(readFileSync(settingsPath(sys), "utf8")) as Settings;
  } catch {
    return undefined;
  }
}

function writeSettings(sys: Sys, s: Settings) {
  writeFileSync(settingsPath(sys), `${JSON.stringify(s, null, 2)}\n`);
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

/**
 * The commands that post a question and read its answer. Each would otherwise stop at a
 * permission prompt before the question reaches the owner. `starbridge run` stays out: the
 * command it wraps is the agent's own.
 */
export const ALLOW_RULES = [
  "Bash(starbridge ask:*)",
  "Bash(starbridge waiting:*)",
  "Bash(starbridge working:*)",
  "Bash(starbridge wait:*)",
  "Bash(starbridge settle:*)",
];

function allowList(s: Settings | undefined): string[] {
  const allow = s?.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === "string") : [];
}

/** The rules of ALLOW_RULES missing from user settings. */
export function missingAllowRules(sys: Sys): string[] {
  const have = new Set(allowList(readSettings(sys)));
  return ALLOW_RULES.filter((r) => !have.has(r));
}

/** False, writing nothing, when settings.json exists but does not parse. */
export function addAllowRules(sys: Sys): boolean {
  const read = readSettings(sys);
  if (!read && existsSync(settingsPath(sys))) return false;
  const s: Settings = read ?? {};
  const allow = allowList(s);
  s.permissions = {
    ...s.permissions,
    allow: [...allow, ...ALLOW_RULES.filter((r) => !allow.includes(r))],
  };
  mkdirSync(claudeDir(sys), { recursive: true });
  writeSettings(sys, s);
  return true;
}

/** Removes ALLOW_RULES from user settings. False when none was there. */
export function removeAllowRules(sys: Sys): boolean {
  const s = readSettings(sys);
  const allow = allowList(s);
  if (!s?.permissions || !allow.some((r) => ALLOW_RULES.includes(r))) return false;
  s.permissions.allow = allow.filter((r) => !ALLOW_RULES.includes(r));
  writeSettings(sys, s);
  return true;
}
