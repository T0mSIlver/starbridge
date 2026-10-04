/**
 * Setup's Claude Code step: the Starbridge marketplace and its two plugins, at user scope, and
 * the manual installs they replace (a copied mod, a copied skill, the CLAUDE.md rule).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastLine, run, type Sys, which } from "./sys";

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

async function listJson<T>(sys: Sys, ...args: string[]): Promise<T[] | undefined> {
  const r = await claude(sys, ...args, "--json");
  if (r?.code !== 0) return undefined;
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return Array.isArray(v) ? (v as T[]) : undefined;
  } catch {
    return undefined;
  }
}

export interface PluginState {
  marketplace: boolean;
  /** Installed at user scope, with whether each is enabled. */
  plugins: Record<string, { enabled: boolean; version?: string } | undefined>;
}

/** Undefined when `claude` is missing or does not answer. */
export async function pluginState(sys: Sys): Promise<PluginState | undefined> {
  const markets = await listJson<{ name: string }>(sys, "plugin", "marketplace", "list");
  const installed = await listJson<{
    id: string;
    scope: string;
    enabled: boolean;
    version?: string;
  }>(sys, "plugin", "list");
  if (!markets || !installed) return undefined;
  const plugins: PluginState["plugins"] = {};
  for (const id of PLUGINS) {
    const p = installed.find((x) => x.id === id && x.scope === "user");
    plugins[id] = p
      ? { enabled: p.enabled, ...(p.version ? { version: p.version } : {}) }
      : undefined;
  }
  return { marketplace: markets.some((m) => m.name === MARKETPLACE), plugins };
}

/** Adds the marketplace and installs what is missing. Returns one line per thing done. */
export async function installPlugins(sys: Sys, state: PluginState): Promise<string[]> {
  const done: string[] = [];
  if (!state.marketplace) {
    const r = await claude(sys, "plugin", "marketplace", "add", MARKETPLACE_SOURCE);
    if (r?.code !== 0)
      throw new Error(`claude plugin marketplace add ${MARKETPLACE_SOURCE}: ${lastLine(r)}`);
    done.push(`Added the ${MARKETPLACE} marketplace.`);
  }
  for (const id of PLUGINS) {
    if (state.plugins[id]) continue;
    const r = await claude(sys, "plugin", "install", id, "--scope", "user");
    if (r?.code !== 0) throw new Error(`claude plugin install ${id}: ${lastLine(r)}`);
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
      r?.code === 0 ? `Uninstalled the ${id} plugin.` : `Could not uninstall ${id}: ${lastLine(r)}`,
    );
  }
  if (state.marketplace) {
    const r = await claude(sys, "plugin", "marketplace", "remove", MARKETPLACE);
    done.push(
      r?.code === 0
        ? `Removed the ${MARKETPLACE} marketplace.`
        : `Could not remove the marketplace: ${lastLine(r)}`,
    );
  }
  return done;
}

type Settings = Record<string, unknown> & {
  env?: Record<string, string>;
  extraKnownMarketplaces?: Record<string, Record<string, unknown>>;
};

function settingsPath(sys: Sys) {
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

/** A Starbridge install made by hand that the plugins replace. */
export interface Legacy {
  what: string;
  remove: () => void;
}

const RULE = /use the `starbridge` skill/;

/** Whether `dir` holds the Starbridge mod (its manifest names it `starbridge`). */
function isStarbridgeMod(dir: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8")) as {
      name?: string;
    };
    return m.name === "starbridge" || m.name === "starbridge-mod";
  } catch {
    return false;
  }
}

export function legacyInstalls(sys: Sys): Legacy[] {
  const found: Legacy[] = [];
  const dir = claudeDir(sys);
  const settings = readSettings(sys);
  const dirs = settings?.env?.CLAUDE_CODE_PLUGIN_DIRS;
  if (dirs) {
    const all = dirs.split(":");
    const ours = all.filter(isStarbridgeMod);
    if (ours.length > 0)
      found.push({
        what: `${ours.join(", ")} in CLAUDE_CODE_PLUGIN_DIRS (${settingsPath(sys)})`,
        remove: () => {
          const s = readSettings(sys);
          if (!s?.env?.CLAUDE_CODE_PLUGIN_DIRS) return;
          const rest = s.env.CLAUDE_CODE_PLUGIN_DIRS.split(":").filter((d) => !ours.includes(d));
          if (rest.length > 0) s.env.CLAUDE_CODE_PLUGIN_DIRS = rest.join(":");
          else delete s.env.CLAUDE_CODE_PLUGIN_DIRS;
          writeSettings(sys, s);
        },
      });
  }
  const mod = join(dir, "mods/starbridge");
  if (existsSync(mod) && isStarbridgeMod(mod))
    found.push({
      what: `the copied mod in ${mod}`,
      remove: () => rmSync(mod, { recursive: true, force: true }),
    });
  const skill = join(dir, "skills/starbridge");
  if (existsSync(join(skill, "SKILL.md")))
    found.push({
      what: `the copied skill in ${skill}`,
      remove: () => rmSync(skill, { recursive: true, force: true }),
    });
  const md = join(dir, "CLAUDE.md");
  try {
    const text = readFileSync(md, "utf8");
    if (text.split("\n").some((l) => RULE.test(l)))
      found.push({
        what: `the starbridge skill rule in ${md}`,
        remove: () => {
          const lines = readFileSync(md, "utf8").split("\n");
          writeFileSync(md, lines.filter((l) => !RULE.test(l)).join("\n"));
        },
      });
  } catch {}
  return found;
}
