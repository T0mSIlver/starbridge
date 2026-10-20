/**
 * Setup's steps for the agents other than Claude Code (#239): the `starbridge` skill copied into
 * Codex's skills folder, the Starbridge Pi package (the skill, the rules and the extension that
 * puts answers into the session), and the skill and plugin copied into opencode's config folder
 * (#300), and the Antigravity plugin (#959). The skill and the opencode and Antigravity plugins
 * ship inside this binary, so setup needs no download and installs the version that matches the
 * CLI.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import agyRule from "../../../plugin/rules/antigravity.md" with { type: "text" };
import opencodeRule from "../../../plugin/rules/opencode.md" with { type: "text" };
import skill from "../../../plugin/skills/starbridge/SKILL.md" with { type: "text" };
import { piAgentDir } from "../pi";
import { COMMIT, VERSION } from "../version";
import agyFiles from "./antigravity-files.js";
import { markedSkill, marker, ours } from "./marker";
import plugin from "./opencode-files.js";
import { pruneEmpty, removedLine, removeWritten } from "./remove";
import { failure, run, type Sys, which } from "./sys";

/** What the Codex skill steps need: the agent has no prompt. */
type Home = Pick<Sys, "ctx" | "home">;

/** `$CODEX_HOME/skills/starbridge`, which Codex reads skills from. */
export const codexHome = (sys: Home) => sys.ctx.env.CODEX_HOME || join(sys.home, ".codex");

export function codexSkillDir(sys: Home): string {
  return join(codexHome(sys), "skills", "starbridge");
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

/** Removes the skill setup wrote, keeping the owner's files beside it. Says what it did, if anything. */
export function removeCodexSkill(sys: Sys): string | undefined {
  const dir = codexSkillDir(sys);
  if (!ours(readText(join(dir, "SKILL.md")))) return undefined;
  return removedLine(dir, removeWritten(dir, ["SKILL.md"], codexHome(sys)));
}

/**
 * Codex runs commands in a sandbox with no network. This rule runs the commands that post a
 * question and read its answer outside it, as Claude Code's allow rules let them skip the prompt.
 */
export const CODEX_RULE = `${marker("#")}
# Questions to your devices need the network.
prefix_rule(pattern = ["starbridge", ["ask", "waiting", "working", "wait"]], decision = "allow")
`;

export function codexRulePath(sys: Home): string {
  return join(codexHome(sys), "rules", "starbridge.rules");
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
  pruneEmpty(dirname(codexRulePath(sys)), codexHome(sys));
  return true;
}

/**
 * The Starbridge Pi package, the repository's root `package.json`, at this CLI's release commit
 * (its tag in a build from source), so its extension calls the commands this CLI has and is the
 * code the release's signature covers: a tag can move. Pi keeps the ref pinned through `pi update`.
 */
export const piSource = (version: string, commit?: string) =>
  `git:github.com/T0mSIlver/starbridge@${commit ?? `v${version}`}`;
export const PI_PACKAGE = piSource(VERSION, COMMIT);

export function hasPi(sys: Sys): boolean {
  return which(sys.ctx.env, "pi") !== undefined;
}

/** This repository as a Pi source, at any ref and in any URL form, and no other repository (#763). */
const STARBRIDGE_PI = /github\.com[/:]T0mSIlver\/starbridge(?:\.git)?\/?(?:@.*)?$/i;

/** The package source as Pi's settings list it, when installed (any ref or URL form). */
export function piPackage(sys: Home): string | undefined {
  const dir = piAgentDir({ ...sys.ctx.env, HOME: sys.home });
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

/** Whether process `pid` runs: signal 0 checks without sending; EPERM means another user's. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Where Pi keeps its checkout of this repository (Pi's own layout for a `git:` source). */
const piCheckout = (sys: Home) =>
  join(
    piAgentDir({ ...sys.ctx.env, HOME: sys.home }),
    "git",
    "github.com",
    "T0mSIlver",
    "starbridge",
  );

/**
 * Fetches only the release's commit into Pi's checkout before `pi install`, which would clone the
 * whole repository, over 800 MB and growing (#2039). Pi finds the ref already checked out and only
 * fetches the ref again. Best effort: the checkout is built beside the folder and moved in only
 * once complete, so a failed or interrupted fetch leaves no folder, and Pi clones as before.
 */
async function prefetchPiPackage(sys: Sys) {
  const dir = piCheckout(sys);
  if (existsSync(dir)) return;
  const ref = COMMIT ?? `refs/tags/v${VERSION}`;
  const part = `${dir}.starbridge-${process.pid}`;
  const git = (...args: string[]) => run(sys, "git", ["-C", part, ...args], { timeoutMs: 300_000 });
  try {
    // What an interrupted setup left beside it; another setup's fetch still running stays.
    const parent = dirname(dir);
    if (existsSync(parent))
      for (const f of readdirSync(parent)) {
        const pid = /^starbridge\.starbridge-(\d+)$/.exec(f)?.[1];
        if (pid && !alive(Number(pid))) rmSync(join(parent, f), { recursive: true, force: true });
      }
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    // What Pi writes on a first clone, so a Pi folder kept in git ignores its checkouts.
    const ignore = join(dirname(dirname(dirname(dir))), ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n!.gitignore\n");
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", "https://github.com/T0mSIlver/starbridge"],
      ["fetch", "-q", "--depth", "1", "--no-tags", "origin", ref],
      ["checkout", "-q", "FETCH_HEAD"],
    ]) {
      const r = await git(...args);
      if (r?.code !== 0) throw new Error(failure(r));
    }
    renameSync(part, dir);
  } catch {
    // Nothing here may stop `pi install`, which clones by itself.
    try {
      rmSync(part, { recursive: true, force: true });
    } catch {}
  }
}

export async function installPiPackage(sys: Sys) {
  await prefetchPiPackage(sys);
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
    "starbridge/plugin/rules/opencode.md": opencodeRule,
  };
}

/** Every file setup writes into opencode's folder as it is now, to tell whether a write changed one. */
export function opencodeSnapshot(sys: Home): string {
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

/**
 * Removes what setup wrote, only the files that are Starbridge's; the owner's files beside them
 * stay. Returns one line per thing done.
 */
export function removeOpencode(sys: Home): string[] {
  const dir = opencodeDir(sys);
  const done: string[] = [];
  const read = (path: string) => readIn(dir, path);
  const remove = (folder: string) => {
    const files = Object.keys(opencodeFiles())
      .filter((path) => path.startsWith(`${folder}/`))
      .map((path) => path.slice(folder.length + 1));
    done.push(removedLine(join(dir, folder), removeWritten(join(dir, folder), files, dir)));
  };
  if (ours(read(SKILL_FILE))) remove("skills/starbridge");
  if (ours(read(ENTRY_FILE))) {
    rmSync(join(dir, ENTRY_FILE), { force: true });
    pruneEmpty(dirname(join(dir, ENTRY_FILE)), dir);
    done.push(`Removed ${join(dir, ENTRY_FILE)}.`);
  }
  // An entry the owner wrote stays, and so does the code it loads.
  if (read(ENTRY_FILE) === undefined && read("starbridge/mod/opencode/starbridge.ts") !== undefined)
    remove("starbridge");
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

/**
 * Every file of the Antigravity plugin, by path inside its folder, the rule first: written first,
 * it marks a plugin an interrupted install left half written as Starbridge's (#1334). A file a
 * later release stops writing stays listed, so a refresh or a removal still takes it away.
 */
function antigravityFiles(): Record<string, string> {
  return {
    // An always_on rule is in every conversation's context, as the SessionStart hook's is.
    [AGY_RULE]: `---\n${marker("#")}\ntrigger: always_on\n---\n\n${agyRule}`,
    ...agyFiles,
    "skills/starbridge/SKILL.md": SKILL,
  };
}

/**
 * Whether Antigravity has the plugin, and whether it is this CLI's: its rule has the marker. With
 * no rule, it is when another of its files is as this release writes it, as after an interrupted
 * install or the rule deleted (#1334); a rule without the marker is the owner's.
 */
export function antigravityState(sys: Home): FileState {
  const dir = antigravityDir(sys);
  if (!existsSync(dir)) return "missing";
  const ruleText = readIn(dir, AGY_RULE);
  const ourFiles = () =>
    Object.entries(agyFiles).some(([path, want]) => readIn(dir, path) === want);
  if (ruleText === undefined ? !ourFiles() : !ours(ruleText)) return "foreign";
  const current = Object.entries(antigravityFiles()).every(
    ([path, want]) => readIn(dir, path) === want,
  );
  return current ? "current" : "outdated";
}

/** Writes the plugin's files; the owner's files in its folder stay. */
export function installAntigravity(sys: Home) {
  const dir = antigravityDir(sys);
  for (const [path, body] of Object.entries(antigravityFiles())) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

/** `agy`'s settings file. The app and the IDE keep their own, which setup does not know. */
export function agySettingsPath(sys: Home): string {
  return join(sys.home, ".gemini", "antigravity-cli", "settings.json");
}

/** Removes the plugin, only when it is the one setup wrote; the owner's files in its folder stay. */
export function removeAntigravity(sys: Home): string | undefined {
  const state = antigravityState(sys);
  if (state === "missing" || state === "foreign") return undefined;
  const dir = antigravityDir(sys);
  return removedLine(
    dir,
    removeWritten(dir, Object.keys(antigravityFiles()), join(sys.home, ".gemini")),
  );
}
