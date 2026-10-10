/**
 * Setup's steps for the agents other than Claude Code (#239): the `starbridge` skill copied into
 * Codex's skills folder, the Starbridge Pi package (the skill, the rules and the extension that
 * puts answers into the session), and the skill and plugin copied into opencode's config folder
 * (#300), and the Antigravity plugin (#959). The skill and the opencode and Antigravity plugins
 * ship inside this binary, so setup needs no download and installs the version that matches the
 * CLI.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import rule from "../../../plugin/hooks/rule.md" with { type: "text" };
import skill from "../../../plugin/skills/starbridge/SKILL.md" with { type: "text" };
import { VERSION } from "../version";
import agyFiles from "./antigravity-files.js";
import { codexPluginDir, refreshCodexPluginFiles } from "./codex-plugin";
import { cursorHooksPath, cursorSkillDir, cursorState, installCursorFiles } from "./cursor";
import { markedSkill, marker, ours } from "./marker";
import plugin from "./opencode-files.js";
import { failure, run, type Sys, which } from "./sys";

/** What the Codex skill steps need: the agent has no prompt. */
type Home = Pick<Sys, "ctx" | "home">;

/** `$CODEX_HOME/skills/starbridge`, which Codex reads skills from. */
export function codexSkillDir(sys: Home): string {
  return join(sys.ctx.env.CODEX_HOME || join(sys.home, ".codex"), "skills", "starbridge");
}

export function hasCodex(sys: Sys): boolean {
  return which(sys.ctx.env, "codex") !== undefined;
}

/** The skill as setup writes it: with its marker. */
export const SKILL = markedSkill(skill);

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Whether a file setup writes is there, whether it is this CLI's version, or whether it is
 * someone else's (no marker), which setup leaves alone.
 */
export type FileState = "missing" | "current" | "outdated" | "foreign";

function fileState(text: string | undefined, want: string, owned: boolean): FileState {
  if (text === undefined) return "missing";
  if (text === want) return "current";
  return owned ? "outdated" : "foreign";
}

export function codexSkill(sys: Home): FileState {
  const text = readText(join(codexSkillDir(sys), "SKILL.md"));
  return fileState(text, SKILL, ours(text));
}

export function installCodexSkill(sys: Home) {
  const dir = codexSkillDir(sys);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL);
}

/** Removes the skill folder, only when it holds the skill setup wrote. */
export function removeCodexSkill(sys: Sys): boolean {
  const dir = codexSkillDir(sys);
  if (!ours(readText(join(dir, "SKILL.md")))) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Codex runs commands in a sandbox with no network. This rule runs the commands that post a
 * question and read its answer outside it, as Claude Code's allow rules let them skip the prompt.
 */
export const CODEX_RULE = `${marker("#")}
# Questions to your devices need the network.
prefix_rule(pattern = ["starbridge", ["ask", "waiting", "working", "wait", "settle"]], decision = "allow")
`;

export function codexRulePath(sys: Home): string {
  return join(sys.ctx.env.CODEX_HOME || join(sys.home, ".codex"), "rules", "starbridge.rules");
}

export function codexRule(sys: Home): FileState {
  const text = readText(codexRulePath(sys));
  return fileState(text, CODEX_RULE, ours(text));
}

export function installCodexRule(sys: Home) {
  const path = codexRulePath(sys);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CODEX_RULE);
}

/** Removes the rule file, only when setup wrote it. */
export function removeCodexRule(sys: Home): boolean {
  if (!ours(readText(codexRulePath(sys)))) return false;
  rmSync(codexRulePath(sys), { force: true });
  return true;
}

/**
 * The Starbridge Pi package, the repository's root `package.json`, at this CLI's release tag so
 * its extension calls the commands this CLI has. Pi keeps a tag pinned through `pi update`.
 */
export const piSource = (version: string) => `git:github.com/T0mSIlver/starbridge@v${version}`;
export const PI_PACKAGE = piSource(VERSION);

export function hasPi(sys: Sys): boolean {
  return which(sys.ctx.env, "pi") !== undefined;
}

/** This repository as a Pi source, at any ref and in any URL form, and no other repository (#763). */
const STARBRIDGE_PI = /github\.com[/:]T0mSIlver\/starbridge(?:\.git)?\/?(?:@.*)?$/i;

/** The package source as Pi's settings list it, when installed (any ref or URL form). */
export function piPackage(sys: Home): string | undefined {
  const dir = sys.ctx.env.PI_CODING_AGENT_DIR || join(sys.home, ".pi", "agent");
  let packages: unknown;
  try {
    packages = (
      JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { packages?: unknown }
    ).packages;
  } catch {
    return undefined;
  }
  if (!Array.isArray(packages)) return undefined;
  for (const p of packages) {
    const source = typeof p === "string" ? p : (p as { source?: unknown })?.source;
    if (typeof source === "string" && STARBRIDGE_PI.test(source)) return source;
  }
  return undefined;
}

const pi = (sys: Sys, ...args: string[]) => run(sys, "pi", args, { timeoutMs: 300_000 });

/** Git's own reason when Pi's clone fails ("fatal: could not read Username…"), else the usual. */
function piFailure(r: Awaited<ReturnType<typeof pi>>): string {
  const reason = (r?.stderr ?? "").split("\n").find((l) => /^(fatal|error):/i.test(l.trim()));
  return reason?.trim() ?? failure(r);
}

export async function installPiPackage(sys: Sys) {
  const r = await pi(sys, "install", PI_PACKAGE);
  if (r?.code !== 0) throw new Error(`pi install ${PI_PACKAGE}: ${piFailure(r)}`);
}

export async function removePiPackage(sys: Sys, source: string) {
  const r = await pi(sys, "remove", source);
  if (r?.code !== 0) throw new Error(`pi remove ${source}: ${piFailure(r)}`);
}

export function hasOpencode(sys: Sys): boolean {
  return which(sys.ctx.env, "opencode") !== undefined;
}

/** opencode's global config folder, which it loads skills and plugins from. */
export function opencodeDir(sys: Home): string {
  return join(sys.ctx.env.XDG_CONFIG_HOME || join(sys.home, ".config"), "opencode");
}

/** The file opencode loads as a plugin; the code sits in `starbridge/`, as in this repository. */
const OPENCODE_ENTRY = `${marker("//")}
// Answers and permission prompts through Starbridge.
export { default } from "../starbridge/mod/opencode/starbridge.ts";
`;

/** Every file setup writes into opencode's config folder, by path inside it. */
function opencodeFiles(): Record<string, string> {
  return {
    "skills/starbridge/SKILL.md": SKILL,
    "plugins/starbridge.ts": OPENCODE_ENTRY,
    ...Object.fromEntries(
      Object.entries(plugin).map(([path, body]) => [`starbridge/${path}`, body]),
    ),
    "starbridge/plugin/hooks/rule.md": rule,
  };
}

/** Every file setup writes into opencode's folder as it is now, to tell whether a write changed one. */
function opencodeSnapshot(sys: Home): string {
  const dir = opencodeDir(sys);
  return JSON.stringify(Object.keys(opencodeFiles()).map((path) => readIn(dir, path) ?? null));
}

/**
 * Whether opencode has the skill and plugin, and whether they are this CLI's. A skill or plugin
 * entry without the marker is someone else's, which setup leaves alone, with the code the entry
 * would load: "foreign" when what is left is current (#541).
 */
export function opencodeState(sys: Home): FileState {
  const dir = opencodeDir(sys);
  const foreign = (path: string) => {
    const text = readIn(dir, path);
    return text !== undefined && !ours(text);
  };
  const skillForeign = foreign(SKILL_FILE);
  const pluginForeign = foreign(ENTRY_FILE);
  const same = Object.entries(opencodeFiles())
    .filter(([path]) => !(path === SKILL_FILE ? skillForeign : pluginForeign))
    .map(([path, want]) => {
      try {
        return readFileSync(join(dir, path), "utf8") === want;
      } catch {
        return undefined;
      }
    });
  if (same.every((s) => s === true)) return skillForeign || pluginForeign ? "foreign" : "current";
  if (same.every((s) => s === undefined) && !skillForeign && !pluginForeign) return "missing";
  return "outdated";
}

const SKILL_FILE = "skills/starbridge/SKILL.md";
const ENTRY_FILE = "plugins/starbridge.ts";

const readIn = (dir: string, path: string) => readText(join(dir, path));

/**
 * Writes the skill and the plugin, each only where the file there is Starbridge's or missing:
 * one without the marker, which setup did not write, stays as it is.
 * With `present`, only the ones still there, so an update never brings back one the owner
 * removed. Returns the files it left alone because they are someone else's.
 */
export function installOpencode(sys: Home, present = false): string[] {
  const dir = opencodeDir(sys);
  const skillText = readIn(dir, SKILL_FILE);
  const entryText = readIn(dir, ENTRY_FILE);
  const skillOk = skillText === undefined ? !present : ours(skillText);
  const pluginOk = entryText === undefined ? !present : ours(entryText);
  const foreign = [
    ...(skillText !== undefined && !skillOk ? [join(dir, SKILL_FILE)] : []),
    ...(entryText !== undefined && !pluginOk ? [join(dir, ENTRY_FILE)] : []),
  ];
  for (const [path, body] of Object.entries(opencodeFiles())) {
    if (!(path === SKILL_FILE ? skillOk : pluginOk)) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return foreign;
}

/** Removes what setup wrote, only the files that are Starbridge's. Returns what it removed. */
export function removeOpencode(sys: Home): string[] {
  const dir = opencodeDir(sys);
  const done: string[] = [];
  const read = (path: string) => readIn(dir, path);
  if (ours(read(SKILL_FILE))) {
    rmSync(join(dir, "skills/starbridge"), { recursive: true, force: true });
    done.push(join(dir, "skills/starbridge"));
  }
  if (ours(read(ENTRY_FILE))) {
    rmSync(join(dir, ENTRY_FILE), { force: true });
    done.push(join(dir, ENTRY_FILE));
  }
  // An entry the owner wrote stays, and so does the code it loads.
  if (
    read(ENTRY_FILE) === undefined &&
    read("starbridge/mod/opencode/starbridge.ts") !== undefined
  ) {
    rmSync(join(dir, "starbridge"), { recursive: true, force: true });
    done.push(join(dir, "starbridge"));
  }
  return done;
}

/** Whether `agy` is here: on the PATH, or its folder, which setup never creates. */
export function hasAgy(sys: Sys): boolean {
  return (
    which(sys.ctx.env, "agy") !== undefined ||
    existsSync(join(sys.home, ".gemini", "antigravity-cli"))
  );
}

export function hasAntigravity(sys: Sys): boolean {
  return (
    hasAgy(sys) ||
    which(sys.ctx.env, "antigravity") !== undefined ||
    ["antigravity", "antigravity-ide"].some((p) => existsSync(join(sys.home, ".gemini", p)))
  );
}

/** Whether the owner turned the plugin off in Antigravity, which then runs none of its hooks. */
export function antigravityDisabled(sys: Home): boolean {
  try {
    const config = JSON.parse(
      readFileSync(join(sys.home, ".gemini", "config", "config.json"), "utf8"),
    ) as { plugins?: Record<string, { enabled?: unknown }> };
    return config.plugins?.starbridge?.enabled === false;
  } catch {
    return false;
  }
}

/**
 * The Starbridge plugin in Antigravity's global customizations, which the app, the IDE and `agy`
 * all read. Its rule carries the marker; plugin.json and hooks.json are JSON, with no comments.
 */
export function antigravityDir(sys: Home): string {
  return join(sys.home, ".gemini", "config", "plugins", "starbridge");
}

const AGY_RULE = "rules/starbridge.md";

/** Every file of the Antigravity plugin, by path inside its folder. */
function antigravityFiles(): Record<string, string> {
  return {
    ...agyFiles,
    // An always_on rule is in every conversation's context, as the SessionStart hook's is.
    [AGY_RULE]: `---\n${marker("#")}\ntrigger: always_on\n---\n\n${rule}`,
    "skills/starbridge/SKILL.md": SKILL,
  };
}

/** Whether Antigravity has the plugin, and whether it is this CLI's; one without the marker is someone else's. */
export function antigravityState(sys: Home): FileState {
  const dir = antigravityDir(sys);
  if (!existsSync(dir)) return "missing";
  const ruleText = readIn(dir, AGY_RULE);
  if (!ours(ruleText)) return "foreign";
  const current = Object.entries(antigravityFiles()).every(
    ([path, want]) => readIn(dir, path) === want,
  );
  return current ? "current" : "outdated";
}

/** Writes the plugin, replacing the folder so a file an older release wrote does not linger. */
export function installAntigravity(sys: Home) {
  const dir = antigravityDir(sys);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, body] of Object.entries(antigravityFiles())) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

/**
 * The allow entries for `agy`'s settings, which let the commands the skill runs skip the prompt.
 * A hook cannot do it: `agy` 1.3.2 still prompts after a `PreToolUse` `allow`. An entry also
 * passes the command behind a variable assignment or `env`, so the plugin's hook makes such a
 * line ask again (`hook pre-tool`).
 */
export const AGY_ALLOW = ["ask", "waiting", "working", "wait", "settle", "hello"].map(
  (c) => `command(starbridge ${c})`,
);

/** `agy`'s settings file. The app and the IDE keep their own, which setup does not know. */
export function agySettingsPath(sys: Home): string {
  return join(sys.home, ".gemini", "antigravity-cli", "settings.json");
}

type AgySettings = { permissions?: { allow?: unknown } & Record<string, unknown> } & Record<
  string,
  unknown
>;

function readAgySettings(sys: Home): AgySettings | undefined {
  try {
    const v = JSON.parse(readFileSync(agySettingsPath(sys), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as AgySettings) : undefined;
  } catch {
    return undefined;
  }
}

const agyAllowList = (s: AgySettings | undefined): string[] => {
  const allow = s?.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === "string") : [];
};

/** The entries of AGY_ALLOW missing from `agy`'s settings. */
export function missingAgyAllow(sys: Home): string[] {
  const have = new Set(agyAllowList(readAgySettings(sys)));
  return AGY_ALLOW.filter((r) => !have.has(r));
}

/** Adds AGY_ALLOW to `agy`'s settings. False, writing nothing, when the file does not parse. */
export function addAgyAllow(sys: Home): boolean {
  const read = readAgySettings(sys);
  if (!read && existsSync(agySettingsPath(sys))) return false;
  const s: AgySettings = read ?? {};
  const allow = agyAllowList(s);
  s.permissions = {
    ...s.permissions,
    allow: [...allow, ...AGY_ALLOW.filter((r) => !allow.includes(r))],
  };
  mkdirSync(dirname(agySettingsPath(sys)), { recursive: true });
  writeFileSync(agySettingsPath(sys), `${JSON.stringify(s, null, 2)}\n`);
  return true;
}

/** Removes AGY_ALLOW from `agy`'s settings. False when none was there. */
export function removeAgyAllow(sys: Home): boolean {
  const s = readAgySettings(sys);
  const allow = agyAllowList(s);
  if (!s?.permissions || !allow.some((r) => AGY_ALLOW.includes(r))) return false;
  s.permissions.allow = allow.filter((r) => !AGY_ALLOW.includes(r));
  writeFileSync(agySettingsPath(sys), `${JSON.stringify(s, null, 2)}\n`);
  return true;
}

/** Removes the plugin, only when it is the one setup wrote. */
export function removeAntigravity(sys: Home): boolean {
  if (antigravityState(sys) === "missing" || antigravityState(sys) === "foreign") return false;
  rmSync(antigravityDir(sys), { recursive: true, force: true });
  return true;
}

/**
 * Brings the Codex skill, rule and plugin script, opencode's skill and plugin and the
 * Antigravity plugin to this release's version,
 * where setup wrote them (they carry its marker); it adds nothing. Returns what it did.
 */
export function refreshFiles(sys: Home): string[] {
  const done: string[] = [];
  const step = (what: string, fn: () => unknown) => {
    try {
      fn();
      done.push(`Updated ${what}.`);
    } catch (e) {
      done.push(`Could not update ${what}: ${(e as Error).message}`);
    }
  };
  const skillFile = join(codexSkillDir(sys), "SKILL.md");
  if (codexSkill(sys) === "outdated") step(skillFile, () => installCodexSkill(sys));
  if (codexRule(sys) === "outdated") step(codexRulePath(sys), () => installCodexRule(sys));
  try {
    if (refreshCodexPluginFiles(sys)) done.push(`Updated ${codexPluginDir(sys)}.`);
  } catch (e) {
    done.push(`Could not update ${codexPluginDir(sys)}: ${(e as Error).message}`);
  }
  if (cursorState(sys) === "outdated")
    step(`the Cursor skill and hooks in ${dirname(dirname(cursorSkillDir(sys)))}`, () => {
      if (!installCursorFiles(sys)) throw new Error(`${cursorHooksPath(sys)} cannot be read`);
    });
  // Files someone else wrote keep it outdated: only a write that changed something counts.
  if (opencodeState(sys) === "outdated") {
    const before = opencodeSnapshot(sys);
    step(`the opencode skill and plugin in ${opencodeDir(sys)}`, () => installOpencode(sys, true));
    if (opencodeSnapshot(sys) === before && done.at(-1)?.startsWith("Updated")) done.pop();
  }
  if (antigravityState(sys) === "outdated")
    step(antigravityDir(sys), () => installAntigravity(sys));
  // The entries pass more than the commands once no hook of ours narrows them.
  const agy = antigravityState(sys);
  if ((agy === "foreign" || (agy !== "missing" && antigravityDisabled(sys))) && removeAgyAllow(sys))
    done.push(`Removed the starbridge allow entries from ${agySettingsPath(sys)}.`);
  return done;
}
