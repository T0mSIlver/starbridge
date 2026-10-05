import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import type { Status } from "../src/agent/api";
import { AgentClient } from "../src/agent/client";
import { makeAgent } from "../src/agent/main";
import type { Agent } from "../src/agent/server";
import { run } from "../src/cli";
import { hookPermission, hookSettle } from "../src/hook";
import { buildPermission, fitJson, redactText, summarize } from "../src/permissions";
import { paired, type TestCtx, until } from "./helpers";

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

const SESSION = "11a021ff-830c-44cb-984e-328c53fadf77";
const PUSH = { command: "git push origin main", description: "Push the fix" };

/** What Claude Code 2.1.289 sends a `PermissionRequest` hook (probe of 2026-10-05). */
function request(input: unknown = PUSH, suggestions: unknown[] = []) {
  return JSON.stringify({
    session_id: SESSION,
    cwd: "/work/starbridge",
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: input,
    permission_suggestions: suggestions,
  });
}

const RULES = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
  behavior: "allow",
  destination: "localSettings",
};
const MODE = { type: "setMode", mode: "acceptEdits", destination: "session" };

/**
 * The paired machine with permission prompts on. With `agent`, its agent runs on a socket in its
 * config directory, which the hook finds the way it would in a real install; without, the hook
 * goes to the server itself.
 */
async function machine(agent = true): Promise<TestCtx> {
  const ctx = await paired(server);
  expect(await run(["permissions", "enable"], ctx)).toBe(0);
  if (!agent) ctx.env.STARBRIDGE_NO_AGENT = "1";
  else {
    const a = makeAgent(ctx, { socket: join(ctx.store.dir, "agent.sock"), noQuota: true });
    await a.start();
    agents.push(a);
  }
  ctx.lines.length = 0;
  return ctx;
}

/** Starts the hook and resolves once its prompt reached the server. */
async function ask(ctx: TestCtx, stdin = request(), wait?: string) {
  const before = (await server.opened("permission")).length;
  const out = hookPermission(ctx, stdin, { agent: "claude-code", ...(wait ? { wait } : {}) });
  await until(async () => (await server.opened("permission")).length > before);
  const all = await server.opened("permission");
  return { out, permission: all[all.length - 1] as (typeof all)[number] };
}

const decision = (ctx: TestCtx) =>
  ctx.lines.length === 0 ? undefined : JSON.parse(ctx.lines[0] as string);

for (const viaAgent of [true, false]) {
  const how = viaAgent ? "through the agent" : "without an agent";

  test(`${how}: a device's allow resolves the prompt, once, and devices see it settled`, async () => {
    const ctx = await machine(viaAgent);
    const { out, permission } = await ask(ctx);
    expect(permission).toMatchObject({
      agent: "claude-code",
      tool: "Bash",
      summary: "git push origin main",
      description: "Push the fix",
      source: { machine: "devbox", project: "starbridge", session: SESSION },
      suggestions: [],
    });
    expect(await server.opened("permission", "&open=1")).toHaveLength(1);
    await server.answerPermission(permission.id, { behavior: "allow", scope: "once" });
    expect(await out).toBe(0);
    expect(decision(ctx)).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    await until(async () => (await server.opened("settled")).length === 1);
    expect((await server.opened("settled"))[0]).toMatchObject({
      itemId: permission.id,
      outcome: "device",
      device: "phone",
    });
    expect(await server.opened("permission", "&open=1")).toEqual([]);
  });
}

test("a deny carries its message to the agent", async () => {
  const ctx = await machine();
  const { out, permission } = await ask(ctx);
  await server.answerPermission(permission.id, {
    behavior: "deny",
    scope: "once",
    message: "Push to a branch instead",
  });
  await out;
  expect(decision(ctx).hookSpecificOutput.decision).toEqual({
    behavior: "deny",
    message: "Push to a branch instead",
  });
});

test("wider scopes return Claude Code's own rules with the scope's destination; mode changes are never offered", async () => {
  for (const [scope, destination] of [
    ["session", "session"],
    ["project", "localSettings"],
  ] as const) {
    const ctx = await machine();
    const { out, permission } = await ask(ctx, request(PUSH, [RULES, MODE]));
    expect(permission.suggestions).toEqual([
      { label: "Allow for this session", rule: "Bash(git push:*)", scope: "session" },
      { label: "Always allow in starbridge", rule: "Bash(git push:*)", scope: "project" },
    ]);
    await server.answerPermission(permission.id, { behavior: "allow", scope });
    await out;
    expect(decision(ctx).hookSpecificOutput.decision).toEqual({
      behavior: "allow",
      updatedPermissions: [{ ...RULES, destination }],
    });
  }
});

test("with no answer the hook prints nothing at the deadline and reports the timeout", async () => {
  const ctx = await machine();
  const { out, permission } = await ask(ctx, request(), "2s");
  expect(await out).toBe(0);
  expect(ctx.lines).toEqual([]);
  await until(async () => (await server.opened("settled")).length === 1);
  expect((await server.opened("settled"))[0]).toMatchObject({
    itemId: permission.id,
    outcome: "timeout",
  });
});

test("an answer for another input, a scope not offered, or from a revoked device is refused", async () => {
  const laptop = await server.addDevice("laptop");
  const ctx = await machine();
  const { out, permission } = await ask(ctx, request(), "4s");
  // The server cannot tell these apart from good answers; the machine can.
  await server.answerPermission(
    permission.id,
    { behavior: "allow", scope: "once" },
    { tamper: { inputHash: "A".repeat(43) } },
  );
  const revoked = await server.sealPermissionAnswer(
    permission.id,
    { behavior: "allow", scope: "once" },
    { by: laptop },
  );
  await server.revoke("laptop");
  server.inject(revoked);
  server.inject(
    await server.sealPermissionAnswer(permission.id, { behavior: "allow", scope: "project" }),
  );
  expect(await out).toBe(0);
  expect(ctx.lines).toEqual([]);
  expect(ctx.errors.join("\n")).toContain("ignored an answer");
  await until(async () => (await server.opened("settled"))[0]?.outcome === "timeout");
});

test("wider scopes are offered only when their rules show in full", async () => {
  const long = {
    ...RULES,
    rules: Array.from({ length: 30 }, (_, i) => ({
      toolName: "Bash",
      ruleContent: `make t${i}:*`,
    })),
  };
  const ctx = await machine();
  const { out, permission } = await ask(ctx, request(PUSH, [RULES, long]), "1s");
  expect(permission.suggestions).toEqual([]);
  await out;
});

test("without an agent, SIGTERM or the deadline during the settled report still ends the hook with no answer", async () => {
  for (const cancel of ["sigterm", "deadline"] as const) {
    const abort = new AbortController();
    const ctx = await machine(false);
    ctx.signal = abort.signal;
    const { out, permission } = await ask(ctx, request(), cancel === "deadline" ? "3s" : undefined);
    // The answer skips HTTP, so the hook's settled notice is the next post, and it hangs.
    const posts = server.log.filter((l) => l === "POST /items").length;
    server.stalls.push("/items");
    server.inject(
      await server.sealPermissionAnswer(permission.id, { behavior: "allow", scope: "once" }),
    );
    await until(() => server.log.filter((l) => l === "POST /items").length > posts);
    const started = Date.now();
    if (cancel === "sigterm") abort.abort();
    expect(await out).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(ctx.lines).toEqual([]);
  }
});

test("without an agent, Stop settles every waiting prompt of the session even when a report fails", async () => {
  const ctx = await machine(false);
  const first = await ask(ctx, request());
  const second = await ask(ctx, request({ command: "git push origin dev" }));
  server.failures.push("/items");
  const stop = JSON.stringify({ session_id: SESSION, hook_event_name: "Stop" });
  expect(await hookSettle(ctx, stop, { agent: "claude-code" })).toBe(0);
  expect(await first.out).toBe(0);
  expect(await second.out).toBe(0);
  expect(ctx.lines).toEqual([]);
  expect((await server.opened("settled")).map((st) => st.itemId)).toEqual([second.permission.id]);
});

test("a keyboard answer settles the prompt: PostToolUse for the same call releases the hook", async () => {
  const ctx = await machine();
  const { out, permission } = await ask(ctx);
  // Another tool call of the session finishing settles nothing.
  const other = JSON.stringify({ session_id: SESSION, tool_name: "Read", tool_input: { a: 1 } });
  expect(await hookSettle(ctx, other, { agent: "claude-code" })).toBe(0);
  await Bun.sleep(300);
  expect(await server.opened("settled")).toEqual([]);

  const post = JSON.stringify({
    session_id: SESSION,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: PUSH,
  });
  const started = Date.now();
  expect(await hookSettle(ctx, post, { agent: "claude-code" })).toBe(0);
  await out;
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(ctx.lines).toEqual([]);
  await until(async () => (await server.opened("settled")).length === 1);
  expect((await server.opened("settled"))[0]).toMatchObject({
    itemId: permission.id,
    outcome: "keyboard",
  });
  // A late answer is refused by the server: the prompt is settled.
  await expect(
    server.answerPermission(permission.id, { behavior: "allow", scope: "once" }),
  ).rejects.toThrow("already-answered");
});

test("SIGTERM (Esc or No at the keyboard) reports the prompt settled and prints nothing", async () => {
  const abort = new AbortController();
  const ctx = await machine();
  ctx.signal = abort.signal;
  const { out, permission } = await ask(ctx);
  abort.abort();
  expect(await out).toBe(0);
  expect(ctx.lines).toEqual([]);
  await until(async () => (await server.opened("settled")).length === 1);
  expect((await server.opened("settled"))[0]).toMatchObject({
    itemId: permission.id,
    outcome: "keyboard",
  });
});

test("while disabled the hooks post nothing and print nothing", async () => {
  const ctx = await machine();
  expect(await run(["permissions", "disable"], ctx)).toBe(0);
  expect(await hookPermission(ctx, request(), { agent: "claude-code" })).toBe(0);
  expect(ctx.lines).toEqual(["Permission prompts stay at the keyboard."]);
  expect(await server.opened("permission")).toEqual([]);
  const status = await new AgentClient(join(ctx.store.dir, "agent.sock")).call<Status>(
    "GET",
    "/v1/status",
  );
  expect(status.permissions).toEqual({ enabled: false, waiting: 0 });
});

test("secrets are redacted before sealing; the hash covers the input as received", () => {
  const input = {
    command:
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz curl -H 'Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123' x",
    key: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
  };
  const { permission } = buildPermission(
    { tool_name: "Bash", tool_input: input, session_id: "s" },
    {
      agent: "claude-code",
      source: { project: "p", session: "s" },
      machine: "devbox",
      to: ["phone"],
      now: new Date("2026-10-05T10:00:00Z"),
      waitMs: 570_000,
    },
  );
  for (const secret of ["sk-ant-api03", "ghp_abc", "AAAA"]) {
    expect(permission.input).not.toContain(secret);
    expect(permission.summary).not.toContain(secret);
  }
  expect(permission.summary).toStartWith("ANTHROPIC_API_KEY=[redacted] curl");
  expect(permission.expiresAt).toBe("2026-10-05T10:09:30Z");
  expect(redactText("GITHUB_TOKEN: abc123 and FOO=bar")).toBe(
    "GITHUB_TOKEN: [redacted] and FOO=bar",
  );
  expect(redactText('CUSTOM_TOKEN="abc\\"sensitive-suffix" x')).toBe("CUSTOM_TOKEN=[redacted] x");
  expect(redactText("API_KEY='abc\\'rest' x")).toBe("API_KEY=[redacted] x");
  expect(redactText('PASSWORD="unterminated secret')).toBe("PASSWORD=[redacted]");
  expect(summarize("Edit", { file_path: "/a/b.ts", old_string: "x" })).toBe("/a/b.ts");
  const big = fitJson({ content: "x".repeat(20_000), file_path: "/a" });
  expect(big.length).toBeLessThanOrEqual(8000);
  expect(JSON.parse(big).file_path).toBe("/a");
  const many = fitJson({ args: Array.from({ length: 4000 }, (_, i) => `a"${i}`) });
  expect(many.length).toBeLessThanOrEqual(8000);
  expect(typeof JSON.parse(many).cut).toBe("string");
});

test("an unreachable server, bad input or another agent never blocks the hook", async () => {
  const ctx = await machine(false);
  const m = ctx.store.machine();
  if (!m) throw new Error("not paired");
  ctx.store.saveMachine({ ...m, server: "http://127.0.0.1:1" });
  expect(await hookPermission(ctx, request(), { agent: "claude-code" })).toBe(0);
  expect(ctx.lines).toEqual([]);
  expect(ctx.errors.join("\n")).toContain("permission prompt not sent");
  expect(await hookPermission(ctx, "not json", { agent: "claude-code" })).toBe(0);
  expect(await hookPermission(ctx, request(), { agent: "codex" })).toBe(0);
  expect(ctx.lines).toEqual([]);
});
