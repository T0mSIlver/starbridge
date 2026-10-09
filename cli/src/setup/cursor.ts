/**
 * Setup's Cursor step (#953): the skill in `~/.cursor/skills/starbridge`, and the allow rules in
 * `cli-config.json`, so `cursor-agent` runs the commands that post a question without a prompt.
 * Not a local plugin under `~/.cursor/plugins/local`: `cursor-agent`'s interactive sessions load
 * neither its skills nor its sessionStart and stop hooks (2026.10.01).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FileState, SKILL } from "./harnesses";
import { ours } from "./marker";
import { type Sys, which } from "./sys";

type Home = Pick<Sys, "ctx" | "home">;

/** Cursor's own folder: skills and hooks load from it whatever `CURSOR_CONFIG_DIR` says. */
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

/** Every file setup writes into Cursor's folder, by absolute path. */
function cursorFiles(sys: Home): Record<string, string> {
  return { [join(cursorHome(sys), "skills", "starbridge", "SKILL.md")]: SKILL };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The skill's folder, which names what setup put into Cursor in its output. */
export function cursorSkillDir(sys: Home): string {
  return join(cursorHome(sys), "skills", "starbridge");
}

/** A skill without the marker is someone else's, which setup leaves alone. */
export function cursorState(sys: Home): FileState {
  const files = Object.entries(cursorFiles(sys));
  const skill = readText(join(cursorSkillDir(sys), "SKILL.md"));
  if (skill === undefined) return "missing";
  if (!ours(skill)) return "foreign";
  return files.every(([path, body]) => readText(path) === body) ? "current" : "outdated";
}

export function installCursorFiles(sys: Home) {
  for (const [path, body] of Object.entries(cursorFiles(sys))) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

/** Removes what setup wrote. Returns the paths it removed. */
export function removeCursorFiles(sys: Home): string[] {
  if (!ours(readText(join(cursorSkillDir(sys), "SKILL.md")))) return [];
  rmSync(cursorSkillDir(sys), { recursive: true, force: true });
  return [cursorSkillDir(sys)];
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
