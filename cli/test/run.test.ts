import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Run } from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { makeAgent } from "../src/agent/main";
import type { Agent } from "../src/agent/server";
import { run } from "../src/cli";
import { WithheldError } from "../src/context";
import { ProgressParser, Reporter, type RunInput, runCommand } from "../src/run";
import { paired, type TestCtx, testCtx, until } from "./helpers";

setDefaultTimeout(30_000);

let server: LiveServer;
let agents: Agent[];
beforeEach(async () => {
  server = await LiveServer.start();
  agents = [];
});
afterEach(async () => {
  for (const a of agents) await a.stop();
  server.stop();
});

const ESC = "\x1b";

test.each([
  ["steps", "building [3/7] api\n", { done: 3, total: 7, unit: "step" }],
  ["a percent", "downloading  42% of 1.2 GB", { done: 42, total: 100, unit: "percent" }],
  ["a decimal percent", "42.7 %", { done: 42, total: 100, unit: "percent" }],
  ["OSC 9;4 ended by BEL", `${ESC}]9;4;1;60\x07`, { done: 60, total: 100, unit: "percent" }],
  ["OSC 9;4 ended by ST", `${ESC}]9;4;2;80${ESC}\\`, { done: 80, total: 100, unit: "percent" }],
  ["an OSC removal", `${ESC}]9;4;0;0\x07`, null],
  ["an indeterminate OSC", `${ESC}]9;4;3\x07`, null],
  ["the last of several", "[1/3] a\n[2/3] b\n50%", { done: 50, total: 100, unit: "percent" }],
  ["colour codes around steps", `${ESC}[32m[2/5]${ESC}[0m ok`, { done: 2, total: 5, unit: "step" }],
  ["nothing", "compiling main.rs\n", undefined],
  ["more steps done than total", "[8/7]", undefined],
  ["no steps at all", "[0/0]", undefined],
  ["a percent over 100", "150%", undefined],
  ["a version, not a percent", "v1.2.30%", undefined],
] as const)("progress: %s", (_name, text, expected) => {
  expect(new ProgressParser().feed(Buffer.from(text, "latin1"))).toEqual(expected);
});

test("progress split across two chunks still parses, and is read once", () => {
  const p = new ProgressParser();
  expect(p.feed("step [3/")).toBeUndefined();
  expect(p.feed("7] done\n")).toEqual({ done: 3, total: 7, unit: "step" });
  expect(p.feed(`${ESC}]9;4;1;`)).toBeUndefined();
  expect(p.feed("25\x07")).toEqual({ done: 25, total: 100, unit: "percent" });
  expect(p.feed("no news\n")).toBeUndefined();
});

function collector() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

async function wrapped(ctx: TestCtx, script: string, extra: string[] = []) {
  const out = collector();
  const err = collector();
  const code = await runCommand(ctx, {
    title: "Mac e2e",
    reason: "uses your session and keyboard",
    command: ["bash", "-c", script, ...extra],
    stdout: out.stream,
    stderr: err.stream,
  });
  return { code, out: out.text(), err: err.text() };
}

test("a chained command's output passes through unchanged, and the run ends with its exit code", async () => {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_NO_AGENT = "1";
  const script = `printf '[1/3] build\\n'; printf 'é ünïcode\\r50%%' >&2; printf '[2/3] test\\n' && exit 3`;
  const r = await wrapped(ctx, script);
  expect(r.code).toBe(3);
  expect(r.out).toBe("[1/3] build\n[2/3] test\n");
  expect(r.err).toBe("é ünïcode\r50%");
  const [posted] = (await server.opened("run")) as Run[];
  expect(posted).toMatchObject({
    title: "Mac e2e",
    reason: "uses your session and keyboard",
    exit: { code: 3 },
    source: { machine: "devbox" },
  });
  expect(posted?.progress?.unit).toBeDefined();
});

test.each([
  ["success", "exit 0", 0],
  ["failure", "exit 42", 42],
  ["a signal", "kill -TERM $$", 128 + 15],
])("the exit code on %s is the command's own", async (_name, script, code) => {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_NO_AGENT = "1";
  expect((await wrapped(ctx, script)).code).toBe(code);
  expect(((await server.opened("run")) as Run[])[0]?.exit?.code).toBe(code);
});

test("a command that cannot start exits 127, as in a shell, and still ends the run", async () => {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_NO_AGENT = "1";
  const code = await runCommand(ctx, {
    title: "t",
    reason: "r",
    command: ["/nonexistent/command"],
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  expect(code).toBe(127);
  expect(ctx.errors.at(-1)).toContain("command not found");
  expect(((await server.opened("run")) as Run[])[0]?.exit?.code).toBe(127);
});

test("an unpaired machine still runs the command and keeps its code, with one warning", async () => {
  const ctx = testCtx({ STARBRIDGE_NO_AGENT: "1" });
  const r = await wrapped(ctx, "echo hi; exit 5");
  expect(r).toMatchObject({ code: 5, out: "hi\n" });
  expect(ctx.errors).toEqual([
    "starbridge: the run was not reported: this machine is not paired: run `starbridge pair` first",
  ]);
});

test("without a title, a reason or a command, nothing runs", async () => {
  const ctx = testCtx({ STARBRIDGE_NO_AGENT: "1" });
  const marker = join(ctx.store.dir, "ran");
  const cmd = ["--", "touch", marker];
  expect(await run(["run", "--title", "t", ...cmd], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("--reason");
  expect(await run(["run", "--reason", "r", ...cmd], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("--title");
  expect(await run(["run", "--title", "t", "--reason", "r", "touch", marker], ctx)).toBe(1);
  expect(await run(["run", "--title", "t", "--reason", "r", "--"], ctx)).toBe(1);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("with an agent running, the run goes through it", async () => {
  const machine = await paired(server);
  const socket = join(machine.store.dir, "agent.sock");
  const agent = makeAgent(machine, { socket, noQuota: true });
  await agent.start();
  agents.push(agent);
  // Its own empty config directory: no keys, so anything posted went through the agent.
  const client = testCtx({ STARBRIDGE_AGENT_SOCKET: socket });
  const r = await wrapped(client, "echo '[1/1]'");
  expect(r.code).toBe(0);
  expect(client.errors).toEqual([]);
  const [posted] = (await server.opened("run")) as Run[];
  expect(posted).toMatchObject({ exit: { code: 0 }, progress: { done: 1, total: 1 } });
});

test("a run killed with -9 posts no exit and nothing after, so devices see it lost (#249)", async () => {
  const machine = await paired(server);
  const socket = join(machine.store.dir, "agent.sock");
  const agent = makeAgent(machine, { socket, noQuota: true });
  await agent.start();
  agents.push(agent);
  // The real binary through the agent, as an agent's session runs it. The orphaned sleep ends
  // on its own.
  const p = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/main.ts"),
      "run",
      "--title",
      "Lost run",
      "--reason",
      "r",
      "--",
      "sleep",
      "20",
    ],
    {
      env: {
        ...process.env,
        STARBRIDGE_AGENT_SOCKET: socket,
        STARBRIDGE_CONFIG_DIR: testCtx().store.dir,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await until(async () => (await server.opened("run")).length === 1, 10_000);
  const [start] = (await server.opened("run")) as Run[];
  p.kill("SIGKILL");
  await p.exited;
  await Bun.sleep(1_500);
  const runs = (await server.opened("run")) as Run[];
  expect(runs).toHaveLength(1);
  const [last] = runs;
  expect(last?.exit).toBeUndefined();
  // Nothing re-posts it (no heartbeat from the agent), so its last news stays its start: past
  // RUN_STALE_MS, the clients' state rule (web/src/lib/runs.ts, Run.state on Android) says lost.
  expect(last?.at).toBe(start?.at);
});

test("the reporter posts the start at once, the first progress right after, later progress throttled, a heartbeat, and the exit", async () => {
  const posts: RunInput[] = [];
  const ctx = testCtx();
  const reporter = new Reporter(
    {
      id: "r_1",
      title: "t",
      reason: "r",
      startedAt: "2026-10-05T10:00:00Z",
      project: "p",
      session: "",
    },
    async (input) => {
      posts.push(input);
    },
    ctx,
    { progressMs: 100, heartbeatMs: 400 },
  );
  reporter.start();
  expect(posts).toHaveLength(1);
  // The first progress, printed while the start is in flight, follows it without the throttle
  // (#828): a run whose first line is `[0/5]` shows its steps at once.
  reporter.update({ done: 0, total: 5, unit: "step" });
  await until(() => posts.length === 2, 50);
  expect(posts[1]?.progress).toEqual({ done: 0, total: 5, unit: "step" });
  for (let i = 1; i <= 5; i++) reporter.update({ done: i, total: 5, unit: "step" });
  await Bun.sleep(30);
  expect(posts).toHaveLength(2);
  await until(() => posts.length === 3);
  expect(posts[2]?.progress).toEqual({ done: 5, total: 5, unit: "step" });
  await until(() => posts.length === 4, 1000);
  expect(posts[3]?.progress).toEqual({ done: 5, total: 5, unit: "step" });
  await reporter.finish(0);
  expect(posts.at(-1)?.exit?.code).toBe(0);
  const count = posts.length;
  await Bun.sleep(500);
  expect(posts).toHaveLength(count);
});

test("progress printed while a post is in flight goes out after the progress gap, not the heartbeat's", async () => {
  const posts: RunInput[] = [];
  let release: (() => void) | undefined;
  const reporter = new Reporter(
    { id: "r_1", title: "t", reason: "r", startedAt: "2026-10-05T10:00:00Z", project: "p", session: "" },
    async (input) => {
      posts.push(input);
      if (posts.length === 2) await new Promise<void>((r) => (release = r));
    },
    testCtx(),
    { progressMs: 100, heartbeatMs: 5_000 },
  );
  reporter.start();
  reporter.update({ done: 0, total: 5, unit: "step" });
  await until(() => release !== undefined, 50);
  reporter.update({ done: 1, total: 5, unit: "step" });
  release?.();
  await until(() => posts.length === 3, 1000);
  expect(posts[2]?.progress).toEqual({ done: 1, total: 5, unit: "step" });
  await reporter.finish(0);
});

test("a withheld directory entry pauses the reporter; the exit still goes out (#794)", async () => {
  const posts: RunInput[] = [];
  let withheld = true;
  const reporter = new Reporter(
    {
      id: "r_1",
      title: "t",
      reason: "r",
      startedAt: "2026-10-05T10:00:00Z",
      project: "p",
      session: "",
    },
    async (input) => {
      if (withheld) throw new WithheldError("the server is holding back directory entries");
      posts.push(input);
    },
    testCtx(),
  );
  reporter.start();
  withheld = false;
  await reporter.finish(0);
  expect(posts.at(-1)?.exit?.code).toBe(0);
});

test("the plugin's SessionStart hook adds the rule to reach the owner and the run rule, and ignores a rules.md", async () => {
  const hook = join(import.meta.dir, "..", "..", "plugin", "hooks", "session-start.sh");
  const ctx = testCtx();
  await Bun.write(join(ctx.store.dir, "rules.md"), "Tell me when you run inference.\n");
  const p = Bun.spawn(["sh", hook], { env: { STARBRIDGE_CONFIG_DIR: ctx.store.dir } });
  const out = JSON.parse(await new Response(p.stdout).text());
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  const text = out.hookSpecificOutput.additionalContext as string;
  expect(text).toContain(
    "Reach me through the `starbridge` skill, not here or with AskUserQuestion",
  );
  expect(text).toContain("\n\nRun a command that blocks me");
  expect(text).toContain("`starbridge run`");
  expect(text).not.toContain("inference");
});

test("an agent of another API revision (426) is skipped: the run goes to the server", async () => {
  const machine = await paired(server);
  const socket = join(machine.store.dir, "old-agent.sock");
  const old = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "agent-too-old", detail: "update the agent" }));
  });
  await new Promise<void>((r) => old.listen(socket, r));
  try {
    machine.env.STARBRIDGE_AGENT_SOCKET = socket;
    const r = await wrapped(machine, "exit 0");
    expect(r.code).toBe(0);
    expect(machine.errors).toEqual([]);
    expect(((await server.opened("run")) as Run[])[0]?.exit?.code).toBe(0);
  } finally {
    await new Promise<void>((r) => old.close(() => r()));
  }
});
