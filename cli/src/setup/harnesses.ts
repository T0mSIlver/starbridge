/**
 * Setup's steps for the agents other than Claude Code (#239): the `starbridge` skill copied into
 * Codex's skills folder, and the Starbridge Pi package (the skill, the rules and the extension
 * that puts answers into the session). The skill ships inside this binary, so setup needs no
 * download and installs the version that matches the CLI.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import skill from "../../../plugin/skills/starbridge/SKILL.md" with { type: "text" };
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
