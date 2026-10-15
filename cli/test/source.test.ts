import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSession } from "../src/claude";
import { askLines, bindSession } from "../src/decisions";
import { projectName } from "../src/project";

test("a git worktree's project is its repository, not its generated directory (#970)", () => {
  const root = mkdtempSync(join(tmpdir(), "starbridge-project-"));
  const repo = join(root, "starbridge");
  const tree = join(repo, ".claude", "worktrees", "brave-dancing-lovelace");
  mkdirSync(join(repo, ".git", "worktrees", "brave-dancing-lovelace"), { recursive: true });
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, ".git"), `gitdir: ${repo}/.git/worktrees/brave-dancing-lovelace\n`);
  expect(projectName(tree)).toBe("starbridge");
  expect(projectName(repo)).toBe("starbridge");
  // A submodule's `.git` file points into the parent's modules, not a worktree.
  const sub = join(root, "vendor-lib");
  mkdirSync(sub);
  writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/vendor-lib\n");
  expect(projectName(sub)).toBe("vendor-lib");
  expect(projectName(join(root, "missing"))).toBe("missing");
});

test("a derived, missing or cut-short session name gives way to the first prompt's first sentence (#970, #1181)", () => {
  const env = { CLAUDE_CONFIG_DIR: join(import.meta.dir, "fixtures", "claude") };
  const title = (id: string) => claudeSession(env, id)?.title;
  // Remote Control's "bridge-cse-…": the prompt past the command, skill and system lines.
  expect(title("bridge")).toBe("Fix T0mSIlver/starbridge: cards from Claude Code sessions");
  expect(title("auto")).toBe("Fix T0mSIlver/starbridge #1143!");
  expect(title("unnamed")).toBe("Review the merged PRs");
  expect(title("abbrev")).toBe("Review the diff, e.g. the parser (e.g. GLM 5.3).");
  expect(title("mention")).toBe("Here is the brief for the release.");
  expect(title("numbered")).toBe("Fix the Android crash when a card is dismissed");
  expect(title("user")).toBe("Card declutter");
  expect(title("desktop")).toBe("Starbridge orchestrator");
  // No transcript: a derived name stays out, an auto one stays as Claude Code cut it.
  expect(title("lost")).toBeUndefined();
  expect(title("auto-lost")).toBe("Run the drift checks with GLM 5.3 and then repor...");
});

test("ask says why nothing brings the answer when Claude desktop replaced the mod (#1428)", () => {
  const root = mkdtempSync(join(tmpdir(), "starbridge-synced-"));
  const dir = join(root, "4917e9633546766b");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "starbridge-mod" }),
  );
  mkdirSync(join(root, "sessions"));
  writeFileSync(
    join(root, "sessions", "4242.json"),
    JSON.stringify({ pid: 4242, sessionId: "s-1" }),
  );
  const env = { CLAUDE_CONFIG_DIR: root };
  const argsOf = (pid: number) => (pid === 4242 ? ["claude", "--plugin-dir", dir] : []);
  const claude = { agent: "claude-code" as const, session: "s-1" };
  expect(askLines(claude, "wait", env, argsOf)).toEqual([
    `Claude desktop runs this session with its own copy of starbridge-mod (${dir}), synced without hooks from the computer it runs on, in place of this machine's.`,
  ]);
  // A mod answered after all, a `claude -p` run, which has none by design, or another session.
  expect(askLines(claude, "prompt", env, argsOf)).toEqual([]);
  expect(askLines({ ...claude, headless: true }, "wait", env, argsOf)).toEqual([]);
  expect(askLines({ ...claude, session: "s-2" }, "wait", env, argsOf)).toEqual([]);
  // The copy with its hooks is the mod itself.
  mkdirSync(join(dir, "hooks"));
  writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
  expect(askLines(claude, "wait", env, argsOf)).toEqual([]);
});

test("ask --session names only a session the asker's environment carries (#1748)", () => {
  const q = { question: "Merge?" };
  // A Codex agent started from a Claude Code session's shell may ask as either.
  const env = { CODEX_THREAD_ID: "t1", CLAUDE_CODE_SESSION_ID: "s1" };
  expect(bindSession({ ...q, session: "s1" }, env)).toEqual({ input: { ...q, session: "s1" } });
  expect(bindSession({ ...q, session: "t1" }, env)).toEqual({ input: { ...q, session: "t1" } });
  const other = bindSession({ ...q, session: "t9" }, env);
  expect(other.input).toEqual(q);
  expect(other.warning).toBe(
    "starbridge: --session t9 is not this session, and an answer goes only to the session that asked, so it asks as this session (t1).",
  );
  // Outside every agent's session, any.
  expect(bindSession({ ...q, session: "t9" }, {})).toEqual({ input: { ...q, session: "t9" } });
  expect(bindSession(q, env)).toEqual({ input: q });
});
