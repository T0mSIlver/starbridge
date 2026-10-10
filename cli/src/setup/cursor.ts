/**
 * Setup's Cursor step (#953): the skill in `~/.cursor/skills/starbridge`; the hooks' scripts in
 * `~/.cursor/starbridge` and their entries in `~/.cursor/hooks.json` (#954); and the allow rules
 * in `cli-config.json`, so `cursor-agent` runs the commands that post a question without a prompt.
 * Not a local plugin under `~/.cursor/plugins/local`: `cursor-agent`'s interactive sessions load
 * neither its skills nor its sessionStart and stop hooks (2026.10.01).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import rule from "../../../plugin/hooks/rule.md" with { type: "text" };
import sessionStart from "../../../plugin/hooks/session-start.sh" with { type: "text" };
import { type FileState, SKILL } from "./harnesses";
import { marker, ours } from "./marker";
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

/** Where the hooks' scripts live; its README carries the marker. */
export function cursorScriptsDir(sys: Home): string {
  return join(cursorHome(sys), "starbridge");
}

/** Every file setup writes into Cursor's folder, by absolute path. */
function cursorFiles(sys: Home): Record<string, string> {
  const dir = cursorScriptsDir(sys);
  return {
    [join(cursorHome(sys), "skills", "starbridge", "SKILL.md")]: SKILL,
    [join(dir, "README.md")]:
      `${marker("<!--", "-->")}\n\nThe scripts of Starbridge's entries in ~/.cursor/hooks.json.\n`,
    // The Claude Code plugin's, so both harnesses add the same rule.
    [join(dir, "session-start.sh")]: sessionStart,
    [join(dir, "rule.md")]: rule,
  };
}

/** Starbridge's entries in `~/.cursor/hooks.json`, by event. */
function hookEntries(sys: Home): Record<string, Record<string, unknown>[]> {
  const dir = cursorScriptsDir(sys);
  return {
    // The rule, as the Claude Code plugin's SessionStart adds it (#954).
    sessionStart: [{ command: `sh "${join(dir, "session-start.sh")}" cursor`, timeout: 5 }],
  };
}

export function cursorHooksPath(sys: Home): string {
  return join(cursorHome(sys), "hooks.json");
}

type HooksFile = Record<string, unknown> & { hooks?: Record<string, unknown> };

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The hooks file, `{version: 1}` when there is none; undefined when it does not parse or is not
 * Cursor's shape, which setup then leaves to the owner.
 */
function readHooks(sys: Home): HooksFile | undefined {
  const text = readText(cursorHooksPath(sys));
  if (text === undefined) return { version: 1 };
  try {
    const v = JSON.parse(text) as unknown;
    return isObject(v) && (v.hooks === undefined || isObject(v.hooks))
      ? (v as HooksFile)
      : undefined;
  } catch {
    return undefined;
  }
}

/** An entry is Starbridge's when its command runs a script of its folder. */
function oursEntry(sys: Home, entry: unknown): boolean {
  const command = (entry as { command?: unknown } | null)?.command;
  return typeof command === "string" && command.includes(cursorScriptsDir(sys));
}

/** Whether the file holds an entry of Starbridge's. */
function hasOurs(sys: Home, file: HooksFile): boolean {
  return Object.values(file.hooks ?? {}).some(
    (list) => Array.isArray(list) && list.some((e) => oursEntry(sys, e)),
  );
}

/**
 * The hooks file with Starbridge's entries replaced by `want`'s; the owner's entries, events and
 * other keys as they were. An event that held only Starbridge's entries goes with them.
 */
function withEntries(
  sys: Home,
  file: HooksFile,
  want: Record<string, Record<string, unknown>[]>,
  addVersion = true,
): HooksFile {
  const hooks: Record<string, unknown> = {};
  const events = new Set([...Object.keys(file.hooks ?? {}), ...Object.keys(want)]);
  for (const event of events) {
    const had = file.hooks?.[event];
    // Not a list: not Cursor's shape, and not setup's to fix.
    if (had !== undefined && !Array.isArray(had)) {
      hooks[event] = had;
      continue;
    }
    const list = [...(had ?? []).filter((e) => !oursEntry(sys, e)), ...(want[event] ?? [])];
    if (list.length > 0 || (had !== undefined && had.length === 0)) hooks[event] = list;
  }
  // Cursor refuses a file without a version; one setup adds entries to gets the first.
  return { ...file, ...(addVersion && file.version === undefined ? { version: 1 } : {}), hooks };
}

function hooksCurrent(sys: Home): boolean {
  const file = readHooks(sys);
  // A file setup cannot read stays the owner's to fix: setup says what to add each time.
  if (!file) return false;
  return JSON.stringify(withEntries(sys, file, hookEntries(sys))) === JSON.stringify(file);
}

/** Writes Starbridge's hook entries; false, writing nothing, when the file does not parse. */
function installHooks(sys: Home): boolean {
  const file = readHooks(sys);
  if (!file) return false;
  const next = withEntries(sys, file, hookEntries(sys));
  if (JSON.stringify(next) !== JSON.stringify(file)) {
    mkdirSync(dirname(cursorHooksPath(sys)), { recursive: true });
    writeFileSync(cursorHooksPath(sys), `${JSON.stringify(next, null, 2)}\n`);
  }
  return true;
}

/** What to add to a hooks file setup could not parse. */
export function hooksToAdd(sys: Home): string {
  return JSON.stringify(hookEntries(sys));
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
  const same = files.every(([path, body]) => readText(path) === body);
  return same && hooksCurrent(sys) ? "current" : "outdated";
}

/**
 * Writes the skill, the scripts and the hook entries. Returns false when `hooks.json` does not
 * parse, which is then left as it is.
 */
export function installCursorFiles(sys: Home): boolean {
  for (const [path, body] of Object.entries(cursorFiles(sys))) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return installHooks(sys);
}

/** Removes what setup wrote. Returns one line per thing done. */
export function removeCursorFiles(sys: Home): string[] {
  const done: string[] = [];
  if (ours(readText(join(cursorSkillDir(sys), "SKILL.md")))) {
    rmSync(cursorSkillDir(sys), { recursive: true, force: true });
    done.push(`Removed ${cursorSkillDir(sys)}.`);
  }
  const file = readHooks(sys);
  // Only a file that holds Starbridge's entries is written.
  if (file && existsSync(cursorHooksPath(sys)) && hasOurs(sys, file)) {
    const next = withEntries(sys, file, {}, false);
    writeFileSync(cursorHooksPath(sys), `${JSON.stringify(next, null, 2)}\n`);
    done.push(`Removed Starbridge's entries from ${cursorHooksPath(sys)}.`);
  }
  if (ours(readText(join(cursorScriptsDir(sys), "README.md")))) {
    rmSync(cursorScriptsDir(sys), { recursive: true, force: true });
    done.push(`Removed ${cursorScriptsDir(sys)}.`);
  }
  return done;
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
