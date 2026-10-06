import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexOrigin } from "../src/codex";

test("a codex exec thread is told apart from a TUI thread by its rollout", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const write = (id: string, originator: string, source: string) => {
    const d = new Date(Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16));
    const dir = join(
      home,
      "sessions",
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    const meta = { type: "session_meta", payload: { id, originator, source } };
    writeFileSync(join(dir, `rollout-x-${id}.jsonl`), `${JSON.stringify(meta)}\n`);
  };
  write("01a10e79-d026-74b2-99a0-461327bcb7d9", "codex_exec", "exec");
  write("01a10e7a-4828-7533-8389-55fca2e32225", "codex-tui", "cli");
  expect(codexOrigin(home, "01a10e79-d026-74b2-99a0-461327bcb7d9")).toBe("exec");
  expect(codexOrigin(home, "01a10e7a-4828-7533-8389-55fca2e32225")).toBe("interactive");
  expect(codexOrigin(home, "01a10e7b-0000-7000-8000-000000000000")).toBeUndefined();
});
