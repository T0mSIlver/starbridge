import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAsker, codexThread, codexTitle } from "../src/codex";
import { resolveSource } from "../src/decisions";

test("a Codex rollout tells exec from the TUI, and a sub-agent from its root thread", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const write = (id: string, originator: string, source: unknown, root = id) => {
    const d = new Date(Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16));
    const dir = join(
      home,
      "sessions",
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    const meta = { type: "session_meta", payload: { session_id: root, id, originator, source } };
    writeFileSync(join(dir, `rollout-x-${id}.jsonl`), `${JSON.stringify(meta)}\n`);
  };
  write("01a10e79-d026-74b2-99a0-461327bcb7d9", "codex_exec", "exec");
  write("01a10e7a-4828-7533-8389-55fca2e32225", "codex-tui", "cli");
  expect(codexThread(home, "01a10e79-d026-74b2-99a0-461327bcb7d9")).toEqual({ origin: "exec" });
  expect(codexThread(home, "01a10e7a-4828-7533-8389-55fca2e32225")).toEqual({
    origin: "interactive",
  });
  expect(codexThread(home, "01a10e7b-0000-7000-8000-000000000000")).toBeUndefined();

  // A sub-agent's answer goes to its root thread: `codex queue` refuses sub-agent threads.
  const root = "01a10e7a-4828-7533-8389-55fca2e32225";
  const sub = "01a10e7c-8441-7032-952c-f5b418f06e19";
  write(sub, "codex-tui", { subagent: { thread_spawn: { parent_thread_id: root } } }, root);
  expect(codexAsker({ CODEX_HOME: home, CODEX_THREAD_ID: sub })).toBe(root);
  expect(codexAsker({ CODEX_HOME: home, CODEX_THREAD_ID: root })).toBe(root);
});

test("a Codex card carries the thread's latest name from session_index.jsonl (#952)", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const id = "01a10da5-c3f3-7360-bfee-87f37efe87b0";
  const other = "01a10e7a-4828-7533-8389-55fca2e32225";
  const line = (i: string, name: string) =>
    `${JSON.stringify({ id: i, thread_name: name, updated_at: "2026-10-05T19:59:00Z" })}\n`;
  const env = { CODEX_HOME: home, CODEX_THREAD_ID: id };
  expect(codexTitle(env, id)).toBeUndefined();
  writeFileSync(
    join(home, "session_index.jsonl"),
    line(id, "Ask about README") + line(other, "Other") + line(id, "Fix the README") + "{torn",
  );
  expect(codexTitle(env, id)).toBe("Fix the README");
  expect(resolveSource({ question: "q" }, env, "/work/p").sessionTitle).toBe("Fix the README");
  writeFileSync(join(home, "session_index.jsonl"), line(id, "x".repeat(300)));
  expect(codexTitle(env, id)).toHaveLength(200);
});
