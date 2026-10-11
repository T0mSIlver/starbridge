import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@starbridge/protocol";
import { QUESTION_TOOL, RULE_FILES, renderRule } from "../src/setup/rules";

const read = (path: string) => readFileSync(join(import.meta.dir, "../..", path), "utf8");
const agents = Object.keys(RULE_FILES) as Agent[];

/** What names a harness: its name, and its own ask tool. */
const SPECIFICS: Record<Agent, RegExp> = {
  "claude-code": /Claude Code|AskUserQuestion/,
  codex: /Codex|request_user_input/,
  cursor: /Cursor|askQuestion/,
  opencode: /opencode|your question tool/,
  pi: /\bPi\b|ask_user_question/,
  antigravity: /Antigravity|\bagy\b|ask_question/,
};

test.each(agents)("%s's rule is the template rendered (bun cli/scripts/rules.ts)", (agent) => {
  expect(read(RULE_FILES[agent])).toBe(renderRule(read("plugin/rules/template.md"), agent));
});

test.each(agents)("%s's rule names no other harness's specifics", (agent) => {
  const rule = read(RULE_FILES[agent]);
  for (const other of agents) if (other !== agent) expect(rule.match(SPECIFICS[other])).toBeNull();
  if (QUESTION_TOOL[agent]) expect(rule).toContain(QUESTION_TOOL[agent]);
});

test("the skill names no harness: every harness reads the same one", () => {
  const skill = read("plugin/skills/starbridge/SKILL.md");
  for (const agent of agents) expect(skill.match(SPECIFICS[agent])).toBeNull();
});
