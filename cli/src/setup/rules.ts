/**
 * The session-start rule each harness gets (#1063): `plugin/rules/template.md` with only that
 * harness's lines. The skill stays the same everywhere; what differs by harness and must be known
 * before the first call goes here, and the rest comes from the CLI's own output. The rendered
 * files are committed, since the Claude Code plugin and the Pi package load theirs from this
 * repository; `bun cli/scripts/rules.ts` writes them and a test checks they match.
 */
import type { Agent } from "@starbridge/protocol";

/** Where each harness's rule lives in this repository. */
export const RULE_FILES: Record<Agent, string> = {
  // The Claude Code plugin's SessionStart hook reads the file next to it.
  "claude-code": "plugin/hooks/rule.md",
  codex: "plugin/rules/codex.md",
  cursor: "plugin/rules/cursor.md",
  opencode: "plugin/rules/opencode.md",
  pi: "plugin/rules/pi.md",
  antigravity: "plugin/rules/antigravity.md",
};

/**
 * The harness's own ask tool, when its question reaches the owner's devices too (spec/harnesses.md, "The
 * harness's own ask tool"). Cursor's `askQuestion` fires no hooks, so it has none.
 */
export const QUESTION_TOOL: Record<Agent, string | undefined> = {
  "claude-code": "AskUserQuestion",
  codex: "request_user_input, in Plan mode,",
  cursor: undefined,
  opencode: "your question tool",
  pi: "ask_user_question, when you have it,",
  antigravity: "ask_question",
};

export function renderRule(template: string, agent: Agent): string {
  const tool = QUESTION_TOOL[agent];
  return template.replace(
    "{question tool}",
    tool
      ? ` A quick question may use ${tool} instead, since it reaches my devices too. End its question with a sentence that asks, in 70 characters at most, which titles the card; the whole question starts the card's context.`
      : "",
  );
}
