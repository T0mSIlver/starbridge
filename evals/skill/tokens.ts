/**
 * Counts the tokens each piece of text Starbridge puts in an agent's context costs, on Claude's
 * tokenizer: the SessionStart rule, the skill's entry in the skills list (name and description),
 * which every session carries, and the skill's body, which an agent reads when it uses the skill.
 *
 *   bun evals/skill/tokens.ts [--ref origin/main] [--model claude-sonnet-5-5]
 *
 * Without `--ref` it reads this checkout. Each count is the input of a `claude -p` call with the
 * piece appended to the system prompt, minus that of the same call with "." appended.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  args: process.argv.slice(2),
  options: {
    ref: { type: "string" },
    model: { type: "string", default: "claude-sonnet-5-5" },
  },
});

const repo = join(import.meta.dir, "..", "..");
const read = (path: string) =>
  opt.ref
    ? spawnSync("git", ["-C", repo, "show", `${opt.ref}:${path}`], { encoding: "utf8" }).stdout
    : readFileSync(join(repo, path), "utf8");

const skill = read("plugin/skills/starbridge/SKILL.md");
const front = /^---\n([\s\S]*?)\n---\n/.exec(skill);
const pieces: Record<string, string> = {
  "SessionStart rule (plugin/hooks/rule.md)": read("plugin/hooks/rule.md").trim(),
  "Skill list entry (name, description)": (front?.[1] ?? "")
    .split("\n")
    .filter((l) => /^(name|description):/.test(l))
    .join("\n"),
  "Skill body (SKILL.md)": skill,
};

const dir = mkdtempSync(join(tmpdir(), "tokens-"));
copyFileSync(join(homedir(), ".claude/.credentials.json"), join(dir, ".credentials.json"));
function input(extra: string): number {
  const r = spawnSync(
    "claude",
    ["-p", "Reply with ok.", "--model", opt.model as string, "--tools", "", "--setting-sources", "",
      "--output-format", "json", "--append-system-prompt", extra],
    { cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: "utf8" },
  );
  const u = JSON.parse(r.stdout).usage;
  return u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
}

// Claude Code's own part of the prompt varies from call to call, by a few tokens or by thousands.
// Each count is taken between two baseline calls ("." appended, since appending anything changes
// the prompt) that agree; counts below zero or over half the characters are thrown away. The
// median of three remains.
function cost(text: string): number {
  const counts: number[] = [];
  while (counts.length < 3) {
    const before = input(".");
    const n = input(text) - before;
    if (Math.abs(input(".") - before) <= 5 && n > 0 && n < text.length / 2) counts.push(n);
  }
  return counts.sort((a, b) => a - b)[1] as number;
}
console.log(`| Piece (${opt.ref ?? "this checkout"}) | Tokens |`, "\n|---|---:|");
let always = 0;
for (const [name, text] of Object.entries(pieces)) {
  const n = cost(text);
  if (!name.startsWith("Skill body")) always += n;
  console.log(`| ${name} | ${n} |`);
}
console.log(`| In every session (rule and list entry) | ${always} |`);
rmSync(dir, { recursive: true, force: true });
