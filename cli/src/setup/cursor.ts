/**
 * Setup's Cursor step (#953): the skill in `~/.cursor/skills/starbridge`; the hooks' scripts in
 * `~/.cursor/starbridge` and their entries in `~/.cursor/hooks.json` (#954); and the allow rules
 * in `cli-config.json`, so `cursor-agent` runs the commands that post a question without a prompt.
 * Not a local plugin under `~/.cursor/plugins/local`: `cursor-agent`'s interactive sessions load
 * neither its skills nor its sessionStart and stop hooks (2026.10.01).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import cli from "../../../plugin/hooks/cli.sh" with { type: "text" };
import sessionStart from "../../../plugin/hooks/session-start.sh" with { type: "text" };
import rule from "../../../plugin/rules/cursor.md" with { type: "text" };
import { CURSOR_HOLD_MS } from "../hook";
import { replaceFile } from "../replace";
import { type FileState, SKILL } from "./harnesses";
import { marker, ours } from "./marker";
import { shellQuote } from "./quote";
import { removedLine, removeWritten, writeLeft } from "./remove";
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
    // The Claude Code plugin's script, with Cursor's rule beside it.
    [join(dir, "session-start.sh")]: sessionStart,
    [join(dir, "rule.md")]: rule,
    [join(dir, "cli.sh")]: cli,
  };
}

/** Starbridge's entries in `~/.cursor/hooks.json`, by event. */
function hookEntries(sys: Home, legacy = false): Record<string, Record<string, unknown>[]> {
  const dir = cursorScriptsDir(sys);
  // Before #1749, in double quotes, which a `$` or `"` in the home folder's path broke out of.
  const q = legacy ? (s: string) => `"${s}"` : shellQuote;
  const session = `sh ${q(join(dir, "cli.sh"))} hook session --agent cursor`;
  return {
    // The rule, as the Claude Code plugin's SessionStart adds it (#954).
    sessionStart: [
      { command: `sh ${q(join(dir, "session-start.sh"))} cursor`, timeout: 5 },
      { command: session, timeout: 10 },
    ],
    // Holds for the answers to the conversation's open questions (#956), with no cap on how
    // many turns it starts.
    stop: [{ command: session, timeout: CURSOR_HOLD_MS / 1000 + 60, loop_limit: null }],
    sessionEnd: [{ command: session, timeout: 10 }],
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
  // A file this user cannot read is the owner's to fix, as one that does not parse (#1749).
  if (text === undefined) return existsSync(cursorHooksPath(sys)) ? undefined : { version: 1 };
  try {
    const v = JSON.parse(text) as unknown;
    return isObject(v) && (v.hooks === undefined || isObject(v.hooks))
      ? (v as HooksFile)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An entry is Starbridge's when its command is one setup writes; every release wrote a subset of
 * today's. An owner's entry that runs a script of Starbridge's folder some other way stays theirs
 * (#1493).
 */
function oursEntry(sys: Home, entry: unknown): boolean {
  const command = (entry as { command?: unknown } | null)?.command;
  return (
    typeof command === "string" &&
    [hookEntries(sys), hookEntries(sys, true)].some((entries) =>
      Object.values(entries).some((list) => list.some((e) => e.command === command)),
    )
  );
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
    replaceFile(cursorHooksPath(sys), `${JSON.stringify(next, null, 2)}\n`);
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
  // The owner's files beside Starbridge's stay (#1324).
  const remove = (dir: string) => {
    // Relative paths, so Windows' separators match too.
    const files = Object.keys(cursorFiles(sys))
      .map((path) => relative(dir, path))
      .filter((path) => !path.startsWith("..") && !isAbsolute(path));
    done.push(removedLine(dir, removeWritten(dir, files, cursorHome(sys))));
  };
  if (ours(readText(join(cursorSkillDir(sys), "SKILL.md")))) remove(cursorSkillDir(sys));
  const file = readHooks(sys);
  // Only a file that holds Starbridge's entries is written.
  if (file && existsSync(cursorHooksPath(sys)) && hasOurs(sys, file)) {
    const { version, hooks, ...rest } = withEntries(sys, file, {}, false);
    // With no hooks left, the version setup adds holds nothing either.
    const empty = Object.keys(hooks ?? {}).length === 0 && Object.keys(rest).length === 0;
    writeLeft(cursorHooksPath(sys), empty ? {} : { version, hooks, ...rest });
    done.push(`Removed Starbridge's entries from ${cursorHooksPath(sys)}.`);
  }
  if (ours(readText(join(cursorScriptsDir(sys), "README.md")))) remove(cursorScriptsDir(sys));
  return done;
}

export function cursorConfigPath(sys: Home): string {
  return join(cursorConfigDir(sys), "cli-config.json");
}
