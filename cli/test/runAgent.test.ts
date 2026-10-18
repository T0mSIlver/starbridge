// `starbridge agent`'s own lifecycle (#570, #1919): stopped, it takes its socket or port file with
// it, so later commands never talk to a dead agent.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/main";
import { agentAddress, type TestCtx, testCtx, until } from "./helpers";

/** An agent's context in throwaway folders, stopped by aborting `stop`. */
function agentCtx(): { ctx: TestCtx; stop: AbortController; socket: string } {
  const stop = new AbortController();
  // HOME too: the agent refreshes Codex's and opencode's files under it at start.
  const ctx = {
    ...testCtx({ HOME: mkdtempSync(join(tmpdir(), "starbridge-home-")) }),
    signal: stop.signal,
  };
  return { ctx, stop, socket: agentAddress(ctx.store.dir) };
}

const listeners = () => ["SIGHUP", "SIGBREAK"].map((s) => process.listenerCount(s));

// A hangup is agent.test.ts's, on a real process: `bun test` itself stops on one emitted here.
test("Ctrl-C or SIGTERM stops the agent, removes its socket or port file, and drops its hangup handlers", async () => {
  const { ctx, stop, socket } = agentCtx();
  const before = listeners();
  const ran = runAgent(ctx, { socket, noQuota: true });
  await until(() => existsSync(socket));
  expect(listeners()).toEqual(before.map((n) => n + 1));
  stop.abort();
  expect(await ran).toBe(0);
  expect(existsSync(socket)).toBe(false);
  expect(ctx.errors.at(-1)).toEndWith(" stopping");
  // A later agent in this process is not stopped by them.
  expect(listeners()).toEqual(before);
});

test("--log appends the agent's lines to that file, from start to stop", async () => {
  const { ctx, stop, socket } = agentCtx();
  const log = join(mkdtempSync(join(tmpdir(), "starbridge-log-")), "logs", "agent.log");
  const ran = runAgent(ctx, { socket, noQuota: true, log });
  await until(() => existsSync(socket));
  stop.abort();
  expect(await ran).toBe(0);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines.some((l) => l.includes(`listening on ${socket}`))).toBe(true);
  expect(lines.at(-1)).toEndWith(" stopping");
  expect(ctx.errors).toEqual([]);
});
