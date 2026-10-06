/**
 * Setup's steps for the agents other than Claude Code (#239): the `starbridge` skill copied into
 * Codex's skills folder, the Starbridge Pi package (the skill, the rules and the extension that
 * puts answers into the session), and the skill and plugin copied into opencode's config folder
 * (#300). The skill and the opencode plugin ship inside this binary, so setup needs no download
 * and installs the version that matches the CLI.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import rule from "../../../plugin/hooks/rule.md" with { type: "text" };
import skill from "../../../plugin/skills/starbridge/SKILL.md" with { type: "text" };
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

/** Whether a file setup writes is there, and whether it is this CLI's version. */
export type FileState = "missing" | "current" | "outdated";

function fileState(text: string | undefined, want: string): FileState {
  return text === undefined ? "missing" : text === want ? "current" : "outdated";
}

export function codexSkill(sys: Home): FileState {
  return fileState(readText(join(codexSkillDir(sys), "SKILL.md")), SKILL);
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

/** Whether Codex has the rule; one setup did not write counts as missing and stays. */
export function codexRule(sys: Home): FileState {
  const text = readText(codexRulePath(sys));
  return text !== undefined && !ours(text) ? "missing" : fileState(text, CODEX_RULE);
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

/** The Starbridge Pi package, the repository's root `package.json`. */
export const PI_PACKAGE = "git:github.com/T0mSIlver/starbridge";

export function hasPi(sys: Sys): boolean {
  return which(sys.ctx.env, "pi") !== undefined;
}

/** The package source as Pi's settings list it, when installed (any ref or URL form). */
export function piPackage(sys: Sys): string | undefined {
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
    if (typeof source === "string" && /github\.com[/:]T0mSIlver\/starbridge\b/i.test(source))
      return source;
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

/** Whether opencode has the skill and plugin, and whether they are this CLI's. */
export function opencodeState(sys: Home): FileState {
  const dir = opencodeDir(sys);
  const same = Object.entries(opencodeFiles()).map(([path, want]) => {
    try {
      return readFileSync(join(dir, path), "utf8") === want;
    } catch {
      return undefined;
    }
  });
  if (same.every((s) => s === undefined)) return "missing";
  return same.every((s) => s === true) ? "current" : "outdated";
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

/**
 * Brings the Codex skill and rule and opencode's skill and plugin to this release's version,
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
  if (codexSkill(sys) === "outdated" && ours(readText(skillFile)))
    step(skillFile, () => installCodexSkill(sys));
  if (codexRule(sys) === "outdated") step(codexRulePath(sys), () => installCodexRule(sys));
  if (opencodeState(sys) === "outdated")
    step(`the opencode skill and plugin in ${opencodeDir(sys)}`, () => installOpencode(sys, true));
  return done;
}
