import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { statSync } from "node:fs";
import { createServer, type IncomingMessage, request } from "node:http";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import type { SessionEvent, Status } from "../src/agent/api";
import { AgentClient, AgentError } from "../src/agent/client";
import { makeAgent } from "../src/agent/main";
import type { Agent } from "../src/agent/server";
import { run } from "../src/cli";
import { FAKE_CODEXBAR, paired, type TestCtx, testCtx, until } from "./helpers";

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

const ASK = ["ask", "--question", "Merge #12 now?", "--option", "Merge", "--option", "Wait"];

/** The paired machine with its agent running on a socket in its config directory. */
async function machine(opts: Parameters<typeof makeAgent>[1] = {}) {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_CODEXBAR = FAKE_CODEXBAR;
  const socket = join(ctx.store.dir, "agent.sock");
  const agent = makeAgent(ctx, { socket, ...opts });
  await agent.start();
  agents.push(agent);
  return { ctx, socket, agent };
}

/**
 * A CLI process with its own, empty config directory: it holds no keys, so every command it
 * gets through went through the agent.
 */
function client(socket: string): TestCtx {
  return testCtx({ STARBRIDGE_AGENT_SOCKET: socket });
}

/** A Claude Code session as the thin mod will be: plain HTTP on the socket. */
function session(socket: string, id: string) {
  const http = new AgentClient(socket, "starbridge-mod/test");
  const path = `/v1/sessions/${id}`;
  return {
    hello: () => http.call("POST", `${path}/hello`, { pid: 42, cwd: "/work/x", title: id }),
    events: async (wait = 0) =>
      (await http.call<{ events: SessionEvent[] }>("GET", `${path}/events?wait=${wait}`)).events,
    ack: (acks: string[]) => http.call("POST", `${path}/ack`, { acks }),
    bye: () => http.call("POST", `${path}/bye`),
  };
}

async function ask(c: TestCtx, ...extra: string[]): Promise<string> {
  const before = c.lines.length;
  const code = await run([...ASK, "--default", "Merge at 18:00", ...extra], c);
  if (code !== 0) throw new Error(c.errors.join("\n"));
  return c.lines[before] as string;
}

test("two sessions each get only their own answers, held until they arrive, until acked", async () => {
  const { socket } = await machine();
  const [c1, c2] = [client(socket), client(socket)];
  const s1 = session(socket, "s1");
  const s2 = session(socket, "s2");
  await s1.hello();
  await s2.hello();
  const d1 = await ask(c1, "--session", "s1", "--project", "p");
  const d2 = await ask(c2, "--session", "s2", "--project", "p");
  expect((await server.opened("decision")).map((d) => d.source.session)).toEqual(["s1", "s2"]);

  // Both sessions hold a request; one answer wakes only the session that asked.
  const held1 = s1.events(20);
  const held2 = s2.events(2);
  const started = Date.now();
  await server.answer(d1, { choice: "Wait" });
  const got1 = await held1;
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(got1).toEqual([
    {
      type: "answer",
      decisionId: d1,
      ack: d1,
      line: `Answer to ${d1} (Merge #12 now?): Wait`,
    },
  ]);
  expect(await held2).toEqual([]);

  // Unconfirmed, it comes again; the other session cannot confirm it.
  await s2.ack([d1]);
  expect(await s1.events()).toHaveLength(1);
  await s1.ack([d1]);
  expect(await s1.events()).toEqual([]);

  await server.answer(d2, { choice: "Merge" });
  await until(async () => (await s2.events()).length === 1);
  expect((await s2.events())[0]?.line).toBe(`Answer to ${d2} (Merge #12 now?): Merge`);
  expect(await s1.events()).toEqual([]);

  const status = await new AgentClient(socket).call<Status>("GET", "/v1/status");
  expect(status.machine?.name).toBe("devbox");
  expect(status.server.reachable).toBe(true);
  expect(status.sessions.map((s) => [s.id, s.client, s.title])).toEqual([
    ["s1", "starbridge-mod/test", "s1"],
    ["s2", "starbridge-mod/test", "s2"],
  ]);
  await s1.bye();
  const after = await new AgentClient(socket).call<Status>("GET", "/v1/status");
  expect(after.sessions.map((s) => s.id)).toEqual(["s2"]);
});

test("several CLI clients at once: ask, wait, answers and quota push all go through the agent", async () => {
  const { socket } = await machine();
  const clients = Array.from({ length: 5 }, () => client(socket));
  const ids = await Promise.all(
    clients.map((c, i) => ask(c, "--session", `s${i}`, "--project", "p")),
  );
  expect(new Set(ids).size).toBe(5);
  expect(await server.opened("decision")).toHaveLength(5);

  // A wait for one decision, a wait for any, and the mod's `answers --wait`, all at once.
  const [w1, wAny, mod] = [client(socket), client(socket), client(socket)];
  const waiting = [
    run(["wait", ids[0] as string], w1),
    run(["wait", "--timeout", "20s"], wAny),
    run(["answers", "--session", "s2", "--wait", "20"], mod),
  ];
  await Bun.sleep(200);
  await server.answer(ids[0] as string, { choice: "Merge" });
  await server.answer(ids[2] as string, { choice: "Wait" });
  expect(await Promise.all(waiting)).toEqual([0, 0, 0]);
  expect(w1.lines).toEqual([`Answer to ${ids[0]} (Merge #12 now?): Merge`]);
  expect(wAny.lines).toHaveLength(1);
  expect(JSON.parse(mod.lines[0] as string)).toEqual({
    decisionId: ids[2],
    ack: ids[2],
    line: `Answer to ${ids[2]} (Merge #12 now?): Wait`,
  });
  expect(await run(["answers", "--session", "s2", "--ack", ids[2] as string], mod)).toBe(0);
  expect(await run(["answers", "--session", "s2"], mod)).toBe(0);
  expect(mod.lines).toHaveLength(1);

  const q = client(socket);
  expect(await run(["quota", "push", "--once", "--provider", "claude"], q)).toBe(0);
  expect(q.lines.at(-1)).toMatch(/^posted q_.*1 providers, 3 windows/);
  expect(await server.opened("quota")).toHaveLength(1);
  // The client never had keys of its own.
  expect(q.store.machine()).toBeUndefined();
});

test("the default-time notice comes on time, once, and a late answer still arrives", async () => {
  const { socket } = await machine();
  const c = client(socket);
  const s1 = session(socket, "s1");
  const at = new Date(Date.now() + 2_000).toISOString();
  const id = await ask(c, "--session", "s1", "--project", "p", "--default-at", at);
  const started = Date.now();
  const [notice] = await s1.events(15);
  expect(Date.now() - started).toBeLessThan(6_000);
  expect(notice?.type).toBe("default");
  expect(notice?.line).toMatch(
    new RegExp(
      `^No answer to ${id} \\(Merge #12 now\\?\\) by its default time .+: apply your default: Merge at 18:00$`,
    ),
  );
  await s1.ack([notice?.ack as string]);
  expect(await s1.events()).toEqual([]);
  await server.answer(id, { choice: "Wait" });
  await until(async () => (await s1.events()).length === 1);
  expect((await s1.events())[0]?.type).toBe("answer");
});

test("no notice while the server cannot be reached: an answer may be waiting there", async () => {
  const { socket } = await machine();
  const c = client(socket);
  const s1 = session(socket, "s1");
  // The agent's next two polls fail (retried after 2 s, then 4 s); the third gets the answer.
  server.failures.push("/answers", "/answers");
  const at = new Date(Date.now() + 1_000).toISOString();
  const id = await ask(c, "--session", "s1", "--project", "p", "--default-at", at);
  await server.answer(id, { choice: "Wait" });
  expect(await s1.events(4)).toEqual([]);
  await until(async () => (await s1.events()).length > 0, 10_000);
  expect((await s1.events()).map((e) => e.type)).toEqual(["answer"]);
});

test("an agent restart loses no unconfirmed answer", async () => {
  const { ctx, socket, agent } = await machine();
  const c = client(socket);
  const s1 = session(socket, "s1");
  const id = await ask(c, "--session", "s1", "--project", "p");
  await server.answer(id, { choice: "Merge" });
  await until(async () => (await s1.events()).length === 1);
  await agent.stop();
  expect(() => statSync(socket)).toThrow();

  const again = makeAgent(ctx, { socket });
  await again.start();
  agents.push(again);
  const [e] = await s1.events();
  expect(e?.ack).toBe(id);
  await s1.ack([id]);
  expect(await s1.events()).toEqual([]);
});

test("the socket is the user's only, and a second agent refuses to start", async () => {
  const { ctx, socket } = await machine();
  expect(statSync(socket).mode & 0o777).toBe(0o600);
  expect(statSync(ctx.store.dir).mode & 0o777).toBe(0o700);
  await expect(makeAgent(ctx, { socket }).start()).rejects.toThrow("already runs");
});

test("a client of another API revision gets 426 with what to update", async () => {
  const { socket } = await machine();
  const raw = (api: string | undefined) =>
    new Promise<{ status: number; body: { error: string; detail: string } }>((resolve) => {
      const req = request(
        {
          socketPath: socket,
          path: "/v1/status",
          headers: api ? { "starbridge-api": api } : {},
        },
        (res: IncomingMessage) => {
          let b = "";
          res.on("data", (d) => {
            b += d;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
        },
      );
      req.end();
    });
  const newer = await raw("99");
  expect(newer.status).toBe(426);
  expect(newer.body.error).toBe("agent-too-old");
  expect(newer.body.detail).toContain("restart the agent");
  expect((await raw(undefined)).body.error).toBe("client-too-old");
  expect((await raw("1")).status).toBe(200);
});

test("the CLI goes to the server itself when no agent runs, or when the agent cannot serve it", async () => {
  const ctx = await paired(server);
  // A socket file left by a crashed agent: nobody listens.
  const stale = join(ctx.store.dir, "agent.sock");
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(stale, r));
  await new Promise<void>((r) => dead.close(() => r()));
  expect(await run([...ASK, "--default", "x", "--session", "s1"], ctx)).toBe(0);

  // An agent from another release.
  const old = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "agent-too-old", detail: "update the agent" }));
  });
  await new Promise<void>((r) => old.listen(stale, r));
  try {
    expect(await run([...ASK, "--default", "x", "--session", "s1"], ctx)).toBe(0);
    expect(ctx.errors.at(-1)).toBe("starbridge: update the agent; going to the server directly");
  } finally {
    await new Promise<void>((r) => old.close(() => r()));
  }
  expect(await server.opened("decision")).toHaveLength(2);
});

test("the agent refuses bad requests with the CLI's own messages", async () => {
  const { socket } = await machine();
  const c = client(socket);
  expect(await run(["ask", "--question", "Q?", "--project", "p"], c)).toBe(1);
  expect(c.errors.at(-1)).toContain("--default");
  expect(await run(["wait", "d_nosuch"], c)).toBe(1);
  expect(c.errors.at(-1)).toContain("not a decision this machine asked");
  await expect(new AgentClient(socket).call("GET", "/v1/sessions/a%20b/events")).rejects.toThrow(
    AgentError,
  );
  expect(await server.opened("decision")).toEqual([]);
});

test("the agent uploads quotas on its timer", async () => {
  const { agent } = await machine({ providers: ["claude", "codex"], interval: "1s" });
  await until(async () => (await server.opened("quota")).length >= 1, 10_000);
  const [snap] = await server.opened("quota");
  expect(snap?.providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
  const status = await new AgentClient(agent.socket).call<Status>("GET", "/v1/status");
  expect(status.quota.providers).toEqual(["claude", "codex"]);
  expect(status.quota.lastPostAt).toBeDefined();
});

test("a malformed path gets 400 and the agent keeps serving", async () => {
  const { socket } = await machine();
  await expect(
    new AgentClient(socket).call("GET", "/v1/sessions/%zz/events"),
  ).rejects.toMatchObject({ status: 400, body: { error: "bad-path" } });
  expect((await new AgentClient(socket).call<Status>("GET", "/v1/status")).version).toBeDefined();
});

test("Ctrl-C cuts a wait held at the agent at once", async () => {
  const { socket } = await machine();
  const c = client(socket);
  const id = await ask(c, "--session", "s1", "--project", "p");
  const controller = new AbortController();
  c.signal = controller.signal;
  const done = run(["wait", id], c);
  await Bun.sleep(300);
  const started = Date.now();
  controller.abort();
  expect(await done).toBe(130);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("once the agent posted the decision, a 426 on the wait never posts it again", async () => {
  const ctx = await paired(server);
  const socket = join(ctx.store.dir, "agent.sock");
  // The agent posts, then a newer agent from an upgrade answers the wait.
  const fake = createServer((req, res) => {
    const posted = req.url === "/v1/decisions";
    res.writeHead(posted ? 200 : 426, { "content-type": "application/json" });
    res.end(
      JSON.stringify(posted ? { id: "d_fake" } : { error: "client-too-old", detail: "update it" }),
    );
  });
  await new Promise<void>((r) => fake.listen(socket, r));
  try {
    expect(await run([...ASK, "--default", "x", "--wait"], ctx)).toBe(1);
    expect(ctx.lines).toEqual(["d_fake"]);
    expect(ctx.errors.at(-1)).toBe("starbridge: update it");
  } finally {
    await new Promise<void>((r) => fake.close(() => r()));
  }
  expect(await server.opened("decision")).toEqual([]);
});
