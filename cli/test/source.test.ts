import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSession } from "../src/claude";
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

test("a session name Claude Code derived from the directory is left out (#970)", () => {
  const dir = mkdtempSync(join(tmpdir(), "starbridge-claude-"));
  mkdirSync(join(dir, "sessions"));
  const record = (pid: number, fields: object) =>
    writeFileSync(join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, ...fields }));
  record(1, { sessionId: "s1", name: "starbridge-4c", nameSource: "derived" });
  record(2, { sessionId: "s2", name: "Card declutter", nameSource: "user" });
  expect(claudeSession({ CLAUDE_CONFIG_DIR: dir }, "s1")?.title).toBeUndefined();
  expect(claudeSession({ CLAUDE_CONFIG_DIR: dir }, "s2")?.title).toBe("Card declutter");
});
