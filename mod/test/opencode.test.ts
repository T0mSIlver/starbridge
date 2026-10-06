import { expect, test } from "bun:test";
import { isRun } from "../opencode/starbridge.ts";

test("only `opencode run` counts as run, whatever flags come first", () => {
  const exe = ["/usr/bin/opencode", "/$bunfs/root/src/index.js"];
  expect(isRun([...exe, "run", "hi"])).toBe(true);
  expect(isRun([...exe, "--log-level", "DEBUG", "run", "hi"])).toBe(true);
  // The TUI's plugins run in a worker that sees no command.
  expect(isRun(["/usr/bin/opencode", "/$bunfs/root/src/cli/tui/worker.js"])).toBe(false);
  expect(isRun([...exe, "serve", "--port", "4096"])).toBe(false);
});
