import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answersOf } from "../hooks/node.ts";
import { claim, hookInput, isRun, submitted, waitingSessions } from "../opencode/starbridge.ts";

test("only `opencode run` counts as run, whatever flags come first", () => {
  const exe = ["/usr/bin/opencode", "/$bunfs/root/src/index.js"];
  expect(isRun([...exe, "run", "hi"])).toBe(true);
  expect(isRun([...exe, "--log-level", "DEBUG", "run", "hi"])).toBe(true);
  // The TUI's plugins run in a worker that sees no command.
  expect(isRun(["/usr/bin/opencode", "/$bunfs/root/src/cli/tui/worker.js"])).toBe(false);
  expect(isRun([...exe, "serve", "--port", "4096"])).toBe(false);
});

test("after a restart, the sessions told to expect their answer as a prompt, with a question open or an answer undelivered, get a loop", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const asked = (session: string, more = {}) => ({
    session,
    askedAt: "2026-10-06T11:00:00Z",
    extensionAnswers: true,
    ...more,
  });
  const state = {
    asked: {
      d_open: asked("ses_a"),
      d_unseen: asked("ses_b"),
      d_seen: asked("ses_c"),
      d_settled: asked("ses_d", { settled: true }),
      d_artifact: asked("ses_e", { answerIn: true }),
      d_run: asked("ses_f", { extensionAnswers: undefined }),
      d_old: asked("ses_g", { askedAt: "2026-09-28T11:00:00Z" }),
      d_none: { askedAt: "2026-10-06T11:00:00Z", extensionAnswers: true },
    },
    answers: { d_unseen: { seen: false }, d_seen: { seen: true } },
  };
  expect(waitingSessions(state, now).sort()).toEqual(["ses_a", "ses_b"]);
  expect(waitingSessions({}, now)).toEqual([]);
});

test("of two processes showing a session, only the first to claim an answer submits it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-claims-"));
  const line = "Answer to d_1 (Merge?): Yes";
  const both = await Promise.all([claim(dir, "ses_a", line), claim(dir, "ses_a", line)]);
  expect(both.map((c) => c.state).sort()).toEqual(["held", "mine"]);
  expect((await claim(dir, "ses_b", line)).state).toBe("mine");
  expect((await claim(dir, "ses_a", "Answer to d_2 (Push?): No")).state).toBe("mine");
  // A claim never marked sent, left by a process that died, goes to one taker after a minute:
  // aged on disk, so the taker's own fresh claim is not stale to the other.
  const claims = join(dir, "opencode-claims");
  const past = new Date(Date.now() - 61_000);
  for (const f of readdirSync(claims)) utimesSync(join(claims, f), past, past);
  const takers = await Promise.all([claim(dir, "ses_a", line), claim(dir, "ses_a", line)]);
  expect(takers.map((c) => c.state).sort()).toEqual(["held", "mine"]);
  const later = Date.now() + 61_000;
  // Once sent, any process may confirm it, and nobody takes it over.
  await submitted(dir, "ses_a", line);
  expect((await claim(dir, "ses_a", line, later)).state).toBe("sent");
  rmSync(dir, { recursive: true, force: true });
});

test("the CLI's answers reach opencode only when there is one per question", () => {
  const out = JSON.stringify({ answers: [["Redis"], ["t/cache"]] });
  expect(answersOf(out, 2)).toEqual([["Redis"], ["t/cache"]]);
  expect(answersOf(out, 3)).toBeUndefined();
  // Nothing printed: the terminal answered, or the question never reached the devices.
  expect(answersOf("", 1)).toBeUndefined();
  expect(answersOf(JSON.stringify({ answers: [[1]] }), 1)).toBeUndefined();
});

test("the devices see what opencode's dialog shows: an edit's diff, a command's directories (#489)", () => {
  const ask = (permission: string, patterns: string[], metadata: Record<string, unknown>) =>
    hookInput({ id: "per_1", sessionID: "ses_1", permission, patterns, metadata }, "/w").tool_input;
  const diff = '--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{"x":1}\n';
  // edit, write and apply_patch all ask as `edit`; the path stays first, as the summary.
  const edit = ask("edit", ["package.json"], { filepath: "/w/package.json", diff });
  expect(edit).toEqual({ file_path: "/w/package.json", diff });
  expect(Object.keys(edit)).toEqual(["file_path", "diff"]);
  expect(ask("edit", ["a.ts", "b.ts"], { filepath: 1, diff })).toEqual({
    file_path: "a.ts, b.ts",
    diff,
  });
  expect(
    ask("external_directory", ["/etc/*"], {
      command: "cat /etc/hosts",
      directories: ["/etc"],
      patterns: ["/etc/*"],
    }),
  ).toEqual({ path: "/etc", command: "cat /etc/hosts" });
  expect(ask("bash", ["git push"], { command: "git push" })).toEqual({ command: "git push" });
  // apply_patch: where a move takes a file, and that a delete removes one.
  const files = [
    {
      filePath: "/w/notes.md",
      relativePath: ".husky/pre-commit",
      type: "move",
      movePath: "/w/.husky/pre-commit",
    },
    { filePath: "/w/old.ts", relativePath: "old.ts", type: "delete" },
    { filePath: "/w/a.ts", relativePath: "a.ts", type: "update" },
  ];
  expect(
    ask("edit", ["notes.md", "old.ts", "a.ts"], {
      filepath: "notes.md, old.ts, a.ts",
      diff,
      files,
    }),
  ).toEqual({
    file_path: "notes.md → .husky/pre-commit, old.ts (deleted), a.ts",
    diff,
  });
  // Any other permission brings its metadata; an MCP tool's `*` says nothing.
  expect(ask("doom_loop", ["read"], { tool: "read", input: { filePath: "/w/a" } })).toEqual({
    path: "read",
    tool: "read",
    input: { filePath: "/w/a" },
  });
  expect(ask("github_create_issue", ["*"], {})).toEqual({});
  expect(ask("external_directory", ["/tmp/*"], { filepath: "/tmp/x", parentDir: "/tmp" })).toEqual({
    path: "/tmp/*",
    file_path: "/tmp/x",
    parentDir: "/tmp",
  });
});
