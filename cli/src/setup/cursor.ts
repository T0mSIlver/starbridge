/**
 * Setup's Cursor step (#953): a local Cursor plugin, `~/.cursor/plugins/local/starbridge`, which
 * the IDE and `cursor-agent` load with no install command and which carries the skill and the
 * hooks, so the owner's own `hooks.json` stays untouched; and the allow rules in
 * `cli-config.json`, so `cursor-agent` runs the commands that post a question without a prompt.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import skill from "../../../plugin/skills/starbridge/SKILL.md" with { type: "text" };
import { VERSION } from "../version";
import type { FileState } from "./harnesses";
import { markedSkill, marker, ours } from "./marker";
import { type Sys, which } from "./sys";

type Home = Pick<Sys, "ctx" | "home">;

/** Cursor's own folder: plugins and skills load from it whatever `CURSOR_CONFIG_DIR` says. */
function cursorHome(sys: Home): string {
  return join(sys.home, ".cursor");
}

/** Where `cursor-agent` keeps `cli-config.json` (2026.10.01). */
function cursorConfigDir(sys: Home): string {
  const env = sys.ctx.env;
  if (env.CURSOR_CONFIG_DIR?.trim()) return env.CURSOR_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME, "cursor");
  return cursorHome(sys);
}

/** The IDE, which leaves `~/.cursor`, or the CLI on the PATH. */
export function hasCursor(sys: Sys): boolean {
  return which(sys.ctx.env, "cursor-agent") !== undefined || existsSync(cursorHome(sys));
}

export function cursorPluginDir(sys: Home): string {
  return join(cursorHome(sys), "plugins", "local", "starbridge");
}

/** The plugin's files by path inside its folder; the README carries the marker. */
function pluginFiles(): Record<string, string> {
  return {
    "README.md": `${marker("<!--", "-->")}\n\nStarbridge for Cursor: https://starbridge.run/docs\n`,
    ".cursor-plugin/plugin.json": `${JSON.stringify(
      {
        name: "starbridge",
        version: VERSION,
        description: "Questions and permission prompts to your devices, through Starbridge.",
      },
      null,
      2,
    )}\n`,
    "skills/starbridge/SKILL.md": markedSkill(skill),
  };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A folder without the README's marker is someone else's plugin, which setup leaves alone. */
export function cursorPlugin(sys: Home): FileState {
  const dir = cursorPluginDir(sys);
  const readme = readText(join(dir, "README.md"));
  if (readme === undefined) return existsSync(dir) ? "foreign" : "missing";
  if (!ours(readme)) return "foreign";
  const same = Object.entries(pluginFiles()).every(
    ([path, body]) => readText(join(dir, path)) === body,
  );
  return same ? "current" : "outdated";
}

/** Writes the plugin afresh, so a file an older release shipped does not linger. */
export function installCursorPlugin(sys: Home) {
  const dir = cursorPluginDir(sys);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, body] of Object.entries(pluginFiles())) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

export function removeCursorPlugin(sys: Home): boolean {
  if (!ours(readText(join(cursorPluginDir(sys), "README.md")))) return false;
  rmSync(cursorPluginDir(sys), { recursive: true, force: true });
  return true;
}

/**
 * The commands that post a question and read its answer, as Claude Code's allow rules list them.
 * `Shell(starbridge ask)` matches `starbridge ask` and what starts with `starbridge ask `; a
 * compound command runs without a prompt only when each of its commands is allowed.
 */
export const CURSOR_ALLOW = ["ask", "waiting", "working", "wait", "settle"].map(
  (c) => `Shell(starbridge ${c})`,
);

export function cursorConfigPath(sys: Home): string {
  return join(cursorConfigDir(sys), "cli-config.json");
}

type CliConfig = Record<string, unknown> & {
  permissions?: Record<string, unknown> & { allow?: unknown };
};

/** The config, `{}` when there is none, undefined when it does not parse. */
function readConfig(sys: Home): CliConfig | undefined {
  const text = readText(cursorConfigPath(sys));
  if (text === undefined) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as CliConfig) : undefined;
  } catch {
    return undefined;
  }
}

function allowOf(c: CliConfig): string[] {
  const allow = c.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === "string") : [];
}

export function missingCursorAllow(sys: Home): string[] {
  const c = readConfig(sys);
  const have = new Set(c ? allowOf(c) : []);
  return CURSOR_ALLOW.filter((r) => !have.has(r));
}

/** Adds the rules; false, writing nothing, when the config does not parse. */
export function addCursorAllow(sys: Home): boolean {
  const c = readConfig(sys);
  if (!c) return false;
  const missing = missingCursorAllow(sys);
  if (missing.length === 0) return true;
  const allow = Array.isArray(c.permissions?.allow) ? (c.permissions.allow as unknown[]) : [];
  c.permissions = { ...c.permissions, allow: [...allow, ...missing] };
  mkdirSync(dirname(cursorConfigPath(sys)), { recursive: true });
  writeFileSync(cursorConfigPath(sys), `${JSON.stringify(c, null, 2)}\n`);
  return true;
}

/** Removes the rules setup adds; whether it removed any. */
export function removeCursorAllow(sys: Home): boolean {
  const c = readConfig(sys);
  const allow = c?.permissions?.allow;
  if (!c?.permissions || !Array.isArray(allow)) return false;
  const kept = allow.filter((r) => !CURSOR_ALLOW.includes(r as string));
  if (kept.length === allow.length) return false;
  c.permissions.allow = kept;
  writeFileSync(cursorConfigPath(sys), `${JSON.stringify(c, null, 2)}\n`);
  return true;
}
