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
import { VERSION } from "../version";
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

/** Whether Codex has the skill, and whether it is this CLI's version of it. */
export function codexSkill(sys: Home): "missing" | "current" | "outdated" {
  try {
    return readFileSync(join(codexSkillDir(sys), "SKILL.md"), "utf8") === skill
      ? "current"
      : "outdated";
  } catch {
    return "missing";
  }
}

export function installCodexSkill(sys: Home) {
  const dir = codexSkillDir(sys);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skill);
}

/** Removes the skill folder, only when it holds the Starbridge skill. */
export function removeCodexSkill(sys: Sys): boolean {
  const dir = codexSkillDir(sys);
  let text: string;
  try {
    text = readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch {
    return false;
  }
  if (!/^name: starbridge$/m.test(text)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Codex runs commands in a sandbox with no network. This rule runs the commands that post a
 * question and read its answer outside it, as Claude Code's allow rules let them skip the prompt.
 */
export const CODEX_RULE = `# Written by starbridge setup: questions to your devices need the network.
prefix_rule(pattern = ["starbridge", ["ask", "waiting", "working", "wait", "settle"]], decision = "allow")
`;

export function codexRulePath(sys: Home): string {
  return join(sys.ctx.env.CODEX_HOME || join(sys.home, ".codex"), "rules", "starbridge.rules");
}

export function hasCodexRule(sys: Home): boolean {
  try {
    return readFileSync(codexRulePath(sys), "utf8") === CODEX_RULE;
  } catch {
    return false;
  }
}

export function installCodexRule(sys: Home) {
  const path = codexRulePath(sys);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CODEX_RULE);
}

/** Removes the rule file, only when setup wrote it. */
export function removeCodexRule(sys: Home): boolean {
  if (!hasCodexRule(sys)) return false;
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
const OPENCODE_ENTRY = `// Written by starbridge setup: answers and permission prompts through Starbridge.
export { default } from "../starbridge/mod/opencode/starbridge.ts";
`;

/** Every file setup writes into opencode's config folder, by path inside it. */
function opencodeFiles(): Record<string, string> {
  return {
    "skills/starbridge/SKILL.md": skill,
    "plugins/starbridge.ts": OPENCODE_ENTRY,
    ...Object.fromEntries(
      Object.entries(plugin).map(([path, body]) => [`starbridge/${path}`, body]),
    ),
    "starbridge/plugin/hooks/rule.md": rule,
  };
}

/** Whether opencode has the skill and plugin, and whether they are this CLI's. */
export function opencodeState(sys: Home): "missing" | "current" | "outdated" {
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

function readIn(dir: string, path: string): string | undefined {
  try {
    return readFileSync(join(dir, path), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Writes the skill and the plugin, each only where the file there is Starbridge's or missing:
 * a skill named otherwise, or a `plugins/starbridge.ts` setup did not write, stays as it is.
 * With `present`, only the ones still there, so an update never brings back one the owner
 * removed. Returns the files it left alone because they are someone else's.
 */
export function installOpencode(sys: Home, present = false): string[] {
  const dir = opencodeDir(sys);
  const skillText = readIn(dir, SKILL_FILE);
  const entryText = readIn(dir, ENTRY_FILE);
  const skillOk = skillText === undefined ? !present : /^name: starbridge$/m.test(skillText);
  const pluginOk =
    entryText === undefined
      ? !present
      : entryText.startsWith(OPENCODE_ENTRY.split("\n")[0] as string);
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
  if (/^name: starbridge$/m.test(read(SKILL_FILE) ?? "")) {
    rmSync(join(dir, "skills/starbridge"), { recursive: true, force: true });
    done.push(join(dir, "skills/starbridge"));
  }
  if (read(ENTRY_FILE) === OPENCODE_ENTRY) {
    rmSync(join(dir, ENTRY_FILE), { force: true });
    done.push(join(dir, ENTRY_FILE));
  }
  // An entry the owner changed stays, and so does the code it loads.
  if (
    read(ENTRY_FILE) === undefined &&
    read("starbridge/mod/opencode/starbridge.ts") !== undefined
  ) {
    rmSync(join(dir, "starbridge"), { recursive: true, force: true });
    done.push(join(dir, "starbridge"));
  }
  return done;
}
