import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, Server as HttpServer, type IncomingMessage, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { PNG } from "pngjs";
import { configKey, proof, type SessionEvent, type Status } from "../src/agent/api";
import { AgentClient, AgentError, Interrupted, NoAgent } from "../src/agent/client";
import { makeAgent } from "../src/agent/main";
import type { Agent } from "../src/agent/server";
import { hookStop } from "../src/antigravity";
import { run } from "../src/cli";
import { Store } from "../src/config";
import { countFollowup, hookCursorSession, MAX_EMPTY_FOLLOWUPS } from "../src/hook";
import {
  agentAddress,
  compiledFake,
  FAKE_CODEXBAR,
  fakeCommand,
  listenAt,
  paired,
  type TestCtx,
  testCtx,
  until,
} from "./helpers";

setDefaultTimeout(30_000);

// Windows has no unix sockets for the agent: it listens on loopback TCP behind a port file.
const WINDOWS = process.platform === "win32";

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

/** The paired machine with its agent running where it listens for its config directory. */
async function machine(opts: Parameters<typeof makeAgent>[1] = {}) {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_CODEXBAR = FAKE_CODEXBAR;
  const socket = agentAddress(ctx.store.dir);
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

/**
 * What `p` rejects with. On Windows, `expect(p).rejects` in a test that made a node:http request
 * corrupts Bun's heap, and a later test crashes or hangs (#897,
 * https://github.com/oven-sh/bun/issues/44025, Bun 1.4.2 and 1.4.3); a plain `await` in
 * try/catch does not.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection, got a result");
}

async function ask(c: TestCtx, ...extra: string[]): Promise<string> {
  const before = c.lines.length;
  const code = await run([...ASK, ...extra], c);
  if (code !== 0) throw new Error(c.errors.join("\n"));
  return c.lines[before] as string;
}

test("an image path relative to the asking directory reaches the agent whole", async () => {
  const { socket } = await machine();
  const dir = mkdtempSync(join(tmpdir(), "starbridge-ask-"));
  writeFileSync(join(dir, "shot.png"), PNG.sync.write(new PNG({ width: 4, height: 2 })));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ask(client(socket), "--project", "p", "--image", "shot.png");
  } finally {
    process.chdir(cwd);
  }
  const [d] = await server.opened("decision");
  expect(d?.images).toMatchObject([{ type: "image/png", width: 4, height: 2 }]);
});

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
      question: "Merge #12 now?",
      waiting: false,
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

  // A wait for one decision, a wait for any of session s1's, and the mod's `answers --wait`.
  const [w1, wAny, mod] = [client(socket), client(socket), client(socket)];
  wAny.env.CLAUDE_CODE_SESSION_ID = "s1";
  const waiting = [
    run(["wait", ids[0] as string], w1),
    run(["wait", "--timeout", "20s"], wAny),
    run(["answers", "--session", "s2", "--wait", "20"], mod),
  ];
  // Once the wait for one decision has marked it waiting: a fixed sleep lost that race on a slow
  // runner (#1508).
  await until(async () => (await server.opened("waiting")).length > 0, 10_000);
  await server.answer(ids[0] as string, { choice: "Merge" });
  await server.answer(ids[2] as string, { choice: "Wait" });
  await server.answer(ids[1] as string, { choice: "Merge" });
  expect(await Promise.all(waiting)).toEqual([0, 0, 0]);
  expect(w1.lines).toEqual([`Answer to ${ids[0]} (Merge #12 now?): Merge`]);
  // The wait for one decision marked it waiting.
  expect((await server.opened("waiting")).map((w) => [w.decisionId, w.state])).toEqual([
    [ids[0] as string, "waiting"],
  ]);
  // Not s0's or s2's, which their own wait and mod are due.
  expect(wAny.lines).toEqual([`Answer to ${ids[1]} (Merge #12 now?): Merge`]);
  expect(JSON.parse(mod.lines[0] as string)).toEqual({
    decisionId: ids[2],
    ack: ids[2],
    line: `Answer to ${ids[2]} (Merge #12 now?): Wait`,
    question: "Merge #12 now?",
    waiting: false,
  });
  expect(await run(["answers", "--session", "s2", "--ack", ids[2] as string], mod)).toBe(0);
  expect(JSON.parse(mod.lines[1] as string)).toEqual({ acked: [ids[2]] });
  expect(await run(["answers", "--session", "s2"], mod)).toBe(0);
  expect(mod.lines).toHaveLength(2);

  const q = client(socket);
  expect(await run(["quota", "push", "--once", "--provider", "claude"], q)).toBe(0);
  expect(q.lines.at(-1)).toMatch(/^posted q_.*1 providers, 3 windows/);
  expect(await server.opened("quota")).toHaveLength(1);
  // The client never had keys of its own.
  expect(q.store.machine()).toBeUndefined();
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

test("a wait held at the agent survives an agent restart (#548)", async () => {
  const { ctx, socket, agent } = await machine();
  const c = client(socket);
  const id = await ask(c, "--session", "s1", "--project", "p");
  const done = run(["wait", id, "--timeout", "1m"], c);
  await Bun.sleep(300);
  // A new binary and a service restart: the held request dies with the old agent.
  await agent.stop();
  await Bun.sleep(200);
  const again = makeAgent(ctx, { socket });
  await again.start();
  agents.push(again);
  await server.answer(id, { choice: "Merge" });
  expect(await done).toBe(0);
  expect(c.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
});

test("a wait whose agent stays away goes on at the server (#548)", async () => {
  const { ctx, agent } = await machine();
  const id = await ask(ctx, "--session", "s1", "--project", "p");
  // A clock that runs fast while the agent is away, so its 30 s pass in a moment.
  let speed = 1;
  let last = Date.now();
  let fake = last;
  ctx.now = () => {
    const t = Date.now();
    fake += (t - last) * speed;
    last = t;
    return new Date(fake);
  };
  const done = run(["wait", id, "--timeout", "10m"], ctx);
  await Bun.sleep(300);
  await agent.stop();
  speed = 1000;
  await until(() => ctx.errors.some((e) => e.includes("waiting at the server")));
  speed = 1;
  await server.answer(id, { choice: "Wait" });
  expect(await done).toBe(0);
  expect(ctx.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Wait`);
});

test("a wait whose agent stopped still ends at its timeout (#548)", async () => {
  const { ctx, agent } = await machine();
  const id = await ask(ctx, "--session", "s1", "--project", "p");
  const started = Date.now();
  const done = run(["wait", id, "--timeout", "2s"], ctx);
  await Bun.sleep(300);
  await agent.stop();
  expect(await done).toBe(2);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("the socket is the user's only, and a second agent refuses to start", async () => {
  const { ctx, socket } = await machine();
  // Windows keeps no POSIX modes: the agent narrows the port file's ACL with icacls instead.
  if (!WINDOWS) {
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(ctx.store.dir).mode & 0o777).toBe(0o700);
  }
  expect((await rejection(makeAgent(ctx, { socket }).start())).message).toContain("already runs");
});

test("a second home of the same user never acts through the first home's agent (#1966)", async () => {
  // Windows keeps the agent's port file in each config folder.
  if (WINDOWS) return;
  // Two homes share the user's $XDG_RUNTIME_DIR, as a test home on a dev box does.
  const runtime = mkdtempSync(join(tmpdir(), "starbridge-run-"));
  const home = (name: string): TestCtx => {
    const config = mkdtempSync(join(tmpdir(), `starbridge-home-${name}-`));
    const c = testCtx({ XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime });
    return { ...c, store: new Store(join(config, "starbridge")) };
  };
  const a = await paired(server, "box-a", home("a"));
  const agent = makeAgent(a, { noQuota: true });
  await agent.start();
  agents.push(agent);
  // Unpaired: anything it posts went through the first home's agent, as its machine.
  const b = home("b");
  expect(await run([...ASK, "--session", "s1"], b)).not.toBe(0);
  expect(await server.opened("decision")).toHaveLength(0);
  // An agent reached from another config folder's address refuses the call.
  const astray = new AgentClient(agent.socket, undefined, configKey(b.store.dir));
  const e = await rejection(astray.call("GET", "/v1/status"));
  expect(e).toBeInstanceOf(NoAgent);
  expect(e.message).toContain("serves another config folder");
  expect(await run([...ASK, "--session", "s1"], a)).toBe(0);
  expect(await server.opened("decision")).toHaveLength(1);
});

test("an agent does not start while one from before #1966 serves its machine on agent.sock", async () => {
  if (WINDOWS) return;
  const runtime = mkdtempSync(join(tmpdir(), "starbridge-run-"));
  const config = mkdtempSync(join(tmpdir(), "starbridge-home-"));
  const c = testCtx({ XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime });
  const a = await paired(server, "box-a", { ...c, store: new Store(join(config, "starbridge")) });
  const id = a.store.machine()?.id;
  let machine = id;
  const old = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pid: 4242, machine: { id: machine } }));
  });
  mkdirSync(join(runtime, "starbridge"), { recursive: true });
  await new Promise<void>((r) => old.listen(join(runtime, "starbridge", "agent.sock"), r));
  try {
    const refused = await rejection(makeAgent(a, { noQuota: true }).start());
    expect(refused.message).toContain("an agent of this machine already runs");
    // Another home's older agent, of another machine, is no reason to stay down.
    machine = "m_other";
    const agent = makeAgent(a, { noQuota: true });
    await agent.start();
    agents.push(agent);
  } finally {
    await new Promise<void>((r) => old.close(() => r()));
  }
});

test("a client of another API revision gets 426 with what to update", async () => {
  const { socket } = await machine();
  // On TCP, the call proves the port file's token, or the agent refuses it before its revision.
  const nonce = "0".repeat(32);
  const port = socket.endsWith(".port") ? JSON.parse(readFileSync(socket, "utf8")) : undefined;
  const target = port
    ? {
        host: "127.0.0.1",
        port: port.port,
        headers: {
          "starbridge-nonce": nonce,
          authorization: `Starbridge ${proof(port.token, "client", nonce)}`,
        },
      }
    : { socketPath: socket, headers: {} };
  const raw = (api: string | undefined) =>
    new Promise<{ status: number; body: { error: string; detail: string } }>((resolve) => {
      const req = request(
        {
          ...target,
          path: "/v1/status",
          headers: { ...target.headers, ...(api ? { "starbridge-api": api } : {}) },
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
  // A socket or port file left by a crashed agent: nobody listens.
  const stale = agentAddress(ctx.store.dir);
  const dead = createServer();
  await listenAt(dead, stale);
  await new Promise<void>((r) => dead.close(() => r()));
  expect(await run([...ASK, "--session", "s1"], ctx)).toBe(0);

  // An agent from another release.
  const old = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "agent-too-old", detail: "update the agent" }));
  });
  await listenAt(old, stale);
  try {
    expect(await run([...ASK, "--session", "s1"], ctx)).toBe(0);
    expect(ctx.errors).toContain("starbridge: update the agent; going to the server directly");
  } finally {
    await new Promise<void>((r) => old.close(() => r()));
  }
  expect(await server.opened("decision")).toHaveLength(2);
});

test("the agent refuses bad requests with the CLI's own messages", async () => {
  const { socket } = await machine();
  const c = client(socket);
  expect(await run(["ask", "--project", "p"], c)).toBe(1);
  expect(c.errors.at(-1)).toContain("--question");
  const both = ["--answer-in", "https://claude.ai/artifact/x", "--option", "A", "--option", "B"];
  expect(await run(["ask", "--question", "Q?", "--project", "p", ...both], c)).toBe(1);
  expect(c.errors.at(-1)).toContain("--answer-in takes no --option");
  expect(await run(["wait", "d_nosuch"], c)).toBe(1);
  expect(c.errors.at(-1)).toContain("not a decision this machine asked");
  expect(
    await rejection(new AgentClient(socket).call("GET", "/v1/sessions/a%20b/events")),
  ).toBeInstanceOf(AgentError);
  // A path that does not decode gets 400, and the agent keeps serving.
  expect(
    await rejection(new AgentClient(socket).call("GET", "/v1/sessions/%zz/events")),
  ).toMatchObject({ status: 400, body: { error: "bad-path" } });
  expect((await new AgentClient(socket).call<Status>("GET", "/v1/status")).version).toBeDefined();
  expect(await server.opened("decision")).toEqual([]);
});

// Windows uploads no quotas: CodexBar has no build there (spec/product.md, "Platforms").
test.skipIf(WINDOWS)("the agent uploads quotas on its timer", async () => {
  const { agent } = await machine({ providers: ["claude", "codex"], interval: "1s" });
  const status = () => new AgentClient(agent.socket).call<Status>("GET", "/v1/status");
  // The agent records lastPostAt once the server's answer is back, a moment after the server
  // stored the snapshot, so the test waits on the agent rather than on the server (#2126).
  await until(async () => (await status()).quota.lastPostAt !== undefined, 10_000);
  const [snap] = await server.opened("quota");
  expect(snap?.providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
  expect((await status()).quota.providers).toEqual(["claude", "codex"]);
});

/** A device's call to the server. */
async function asDevice(token: string, method: string, path: string) {
  const r = await fetch(`${server.url}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  return (await r.json()) as { items: unknown[]; behind?: number };
}

// Windows uploads no quotas: CodexBar has no build there (spec/product.md, "Platforms").
test.skipIf(WINDOWS)(
  "the agent posts a snapshot as soon as a device joins, and when one asks",
  async () => {
    await machine({ providers: ["claude"], interval: "1h" });
    await until(async () => (await server.opened("quota")).length >= 1, 10_000);
    const tablet = await server.addDevice("tablet");
    // Sealed before the tablet joined, the first snapshot has no box for it; the hourly timer
    // would leave it with nothing.
    await until(async () => (await asDevice(tablet.token, "GET", "/quota")).items.length === 1);

    const [before] = await server.opened("quota");
    const asked = await asDevice(server.owner.device.token, "POST", "/quota/ask?wait=10");
    expect(asked.behind).toBe(0);
    const [after] = await server.opened("quota");
    expect(after?.id).not.toBe(before?.id);
  },
);

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
  const socket = agentAddress(ctx.store.dir);
  // The agent posts, then a newer agent from an upgrade answers the wait.
  const fake = createServer((req, res) => {
    const posted = req.url === "/v1/decisions";
    res.writeHead(posted ? 200 : 426, { "content-type": "application/json" });
    res.end(
      JSON.stringify(posted ? { id: "d_fake" } : { error: "client-too-old", detail: "update it" }),
    );
  });
  await listenAt(fake, socket);
  try {
    expect(await run([...ASK, "--wait"], ctx)).toBe(1);
    expect(ctx.lines).toEqual(["d_fake"]);
    expect(ctx.errors.at(-1)).toBe("starbridge: update it");
  } finally {
    await new Promise<void>((r) => fake.close(() => r()));
  }
  expect(await server.opened("decision")).toEqual([]);
});

test("a call whose signal already aborted is interrupted without opening a request (#98)", async () => {
  const errors: unknown[] = [];
  const onError = (e: unknown) => errors.push(e);
  process.on("uncaughtException", onError);
  try {
    const abort = new AbortController();
    abort.abort();
    const client = new AgentClient(join(tmpdir(), "starbridge-no-agent.sock"));
    await expect(
      client.call("POST", "/v1/permissions/x/wait", { wait: 1 }, 5_000, abort.signal),
    ).rejects.toBeInstanceOf(Interrupted);
    // A destroyed request reports its hang-up on a later tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(errors).toEqual([]);
  } finally {
    process.off("uncaughtException", onError);
  }
});

/**
 * A Codex home whose daemon socket listens, and a `codex` that logs its arguments. Bun on
 * Windows cannot listen on a unix socket's path, so the tests that need one skip there.
 */
/** Records a Codex home's `codex` and the home in the agent's config, as setup does. */
function trustCodex(ctx: TestCtx, home: string) {
  ctx.store.saveAgentConfig({
    ...ctx.store.agentConfig(),
    codex: { bin: join(home, "bin", "codex"), home },
  });
}

async function codexHome(fail = false) {
  const home = mkdtempSync(join(tmpdir(), "starbridge-codex-"));
  mkdirSync(join(home, "app-server-control"));
  // Reads and drops what a client sends, so it sees the client close.
  const daemon = createNetServer((c) => c.resume());
  await new Promise<void>((r) =>
    daemon.listen(join(home, "app-server-control", "app-server-control.sock"), r),
  );
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "queue.log");
  fakeCommand(
    join(bin, "codex"),
    `#!/bin/sh\necho "$CODEX_HOME $*" >> "${log}"\n${fail ? "echo 'no active session' >&2; exit 1" : ""}\n`,
  );
  // Started from a Claude Code shell, Codex inherits its variables too: Codex still asks.
  const env = {
    CODEX_THREAD_ID: "t1",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "c1",
    CODEX_HOME: home,
    PATH: bin,
  };
  return { env, log, close: () => new Promise<void>((r) => daemon.close(() => r())) };
}

test.skipIf(WINDOWS)(
  "the agent queues a Codex session's answer into it, and ask says it will",
  async () => {
    const { ctx, socket } = await machine();
    const codex = await codexHome();
    trustCodex(ctx, codex.env.CODEX_HOME);
    const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env });
    try {
      const id = await ask(c, "--project", "p");
      expect(c.errors.at(-1)).toBe("The answer will come back into this session as a new prompt.");
      const [d] = await server.opened("decision");
      expect([d?.agent, d?.source.session]).toEqual(["codex", "t1"]);

      await server.answer(id, { choice: "Merge" });
      // The queued message names the decision, never its question or answer: other local users
      // can read a process's arguments. The wait it names prints the answer.
      const queued = `${codex.env.CODEX_HOME} queue --thread t1 --message Starbridge has the owner's answer to ${id}: run \`starbridge wait ${id}\` to read it.\n`;
      // The fake codex creates its log before it has written the line: wait for the line itself.
      // First the agent tries to steer it, which this daemon never answers: 5 s (#1584).
      const log = () => (existsSync(codex.log) ? readFileSync(codex.log, "utf8") : "");
      await until(() => log() === queued, 15_000).catch(() => {});
      expect(log()).toBe(queued);
      expect(await run(["wait", id, "--timeout", "10s"], c)).toBe(0);
      expect(c.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
    } finally {
      await codex.close();
    }
  },
);

test.skipIf(WINDOWS)(
  "a Codex thread T3 Code runs is told to wait, and nothing is queued into the daemon (#2101)",
  async () => {
    const { ctx, socket } = await machine();
    const codex = await codexHome();
    trustCodex(ctx, codex.env.CODEX_HOME);
    // T3 Code runs its own app-server, whose rollout names it; the TUI's daemon listens too.
    const thread = "01a15583-6a63-74b2-873d-d800b7671593";
    const day = new Date(Number.parseInt(thread.replace(/-/g, "").slice(0, 12), 16));
    const dir = join(
      codex.env.CODEX_HOME,
      "sessions",
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    const meta = { id: thread, session_id: thread, originator: "T3 Code", source: "vscode" };
    writeFileSync(
      join(dir, `rollout-x-${thread}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: meta })}\n`,
    );
    const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env, CODEX_THREAD_ID: thread });
    try {
      const id = await ask(c, "--project", "p");
      expect(c.errors.at(-1)).toContain("run `starbridge wait");
      await server.answer(id, { choice: "Merge" });
      expect(await run(["wait", id, "--timeout", "10s"], c)).toBe(0);
      expect(c.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
      // The daemon would have loaded the thread and run the answer's turn out of T3's sight.
      expect(existsSync(codex.log)).toBe(false);
    } finally {
      await codex.close();
    }
  },
);

test.skipIf(WINDOWS)(
  "ask --input chooses neither the codex the agent runs nor what kind of session asks",
  async () => {
    const { ctx, socket } = await machine();
    const codex = await codexHome();
    trustCodex(ctx, codex.env.CODEX_HOME);
    const ran = join(codex.env.CODEX_HOME, "other.ran");
    const other = join(codex.env.CODEX_HOME, "other");
    fakeCommand(other, `#!/bin/sh\ntouch "${ran}"\n`);
    const file = join(codex.env.CODEX_HOME, "ask.json");
    writeFileSync(
      file,
      JSON.stringify({
        question: "Merge #12 now?",
        options: ["Merge", "Wait"],
        codex: { home: codex.env.CODEX_HOME, bin: other },
        held: true,
        picker: "t1",
        nextStep: "t1",
        extensionAnswers: true,
      }),
    );
    const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env });
    try {
      const id = await ask(c, "--input", file, "--project", "p");
      const asked = ctx.store.state().asked[id];
      expect([asked?.held, asked?.picker, asked?.nextStep, asked?.extensionAnswers]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(asked?.codex?.bin).toBe(join(codex.env.CODEX_HOME, "bin", "codex"));
      await server.answer(id, { choice: "Merge" });
      const log = () => (existsSync(codex.log) ? readFileSync(codex.log, "utf8") : "");
      await until(() => log().includes(id), 15_000);
      expect(existsSync(ran)).toBe(false);
    } finally {
      await codex.close();
    }
  },
);

test.skipIf(WINDOWS)(
  "the agent runs only the codex setup recorded, for the CODEX_HOME setup recorded",
  async () => {
    const { ctx, socket } = await machine();
    const codex = await codexHome();
    trustCodex(ctx, codex.env.CODEX_HOME);
    const elsewhere = mkdtempSync(join(tmpdir(), "starbridge-codex-"));
    const ran = join(elsewhere, "other.ran");
    const other = join(elsewhere, "other");
    fakeCommand(other, `#!/bin/sh\ntouch "${ran}"\n`);
    const http = new AgentClient(socket, "starbridge-cli/test");
    const post = (home: string) =>
      http.call<{ id: string; delivery: string }>("POST", "/v1/decisions", {
        input: {
          question: "Merge #12 now?",
          options: ["Merge", "Wait"],
          agent: "codex",
          project: "p",
          session: "t1",
          codex: { home, bin: other },
          held: true,
          nextStep: "t1",
        },
      });
    try {
      // Another home: nothing runs, and the session is told to wait.
      const away = await post(elsewhere);
      expect(away.delivery).toBe("wait");
      expect(ctx.store.state().asked[away.id]?.held).toBeUndefined();
      expect(ctx.store.state().asked[away.id]?.nextStep).toBeUndefined();
      // The recorded home, however spelled: the recorded codex runs for the recorded spelling,
      // never the binary or the path the route names.
      const home = await post(join(codex.env.CODEX_HOME, "x", ".."));
      await server.answer(away.id, { choice: "Wait" });
      await server.answer(home.id, { choice: "Merge" });
      const log = () => (existsSync(codex.log) ? readFileSync(codex.log, "utf8") : "");
      await until(() => log().includes(home.id), 15_000);
      expect(log()).toStartWith(`${codex.env.CODEX_HOME} queue --thread t1`);
      expect(log()).not.toContain(away.id);
      expect(existsSync(ran)).toBe(false);
    } finally {
      await codex.close();
    }
  },
);

// What ask promises a Codex session is the route its answer takes (#2182): a promised prompt is
// queued once, a promised wait queues nothing. Each row: the daemon, the home, how Codex started
// the thread, and the promise.
for (const [name, row] of [
  ["the TUI's daemon listens", { daemon: true, trusted: true, app: false, prompt: true }],
  ["the daemon is down at the ask", { daemon: false, trusted: true, app: false, prompt: false }],
  ["another CODEX_HOME", { daemon: true, trusted: false, app: false, prompt: false }],
  ["T3 Code runs the thread", { daemon: true, trusted: true, app: true, prompt: false }],
] as const)
  test.skipIf(WINDOWS)(
    `a Codex session's answer takes the route ask promised: ${name}`,
    async () => {
      const { ctx, socket } = await machine();
      const codex = await codexHome();
      if (!row.daemon) await codex.close();
      if (row.trusted) trustCodex(ctx, codex.env.CODEX_HOME);
      const thread = "01a15583-6a63-74b2-873d-d800b7671593";
      if (row.app) {
        const day = new Date(Number.parseInt(thread.replace(/-/g, "").slice(0, 12), 16));
        const dir = join(
          codex.env.CODEX_HOME,
          "sessions",
          String(day.getFullYear()),
          String(day.getMonth() + 1).padStart(2, "0"),
          String(day.getDate()).padStart(2, "0"),
        );
        mkdirSync(dir, { recursive: true });
        const meta = { id: thread, session_id: thread, originator: "T3 Code", source: "vscode" };
        writeFileSync(
          join(dir, `rollout-x-${thread}.jsonl`),
          `${JSON.stringify({ type: "session_meta", payload: meta })}\n`,
        );
      }
      const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env, CODEX_THREAD_ID: thread });
      try {
        const id = await ask(c, "--project", "p");
        expect(c.errors.at(-1) === PROMPT).toBe(row.prompt);
        await server.answer(id, { choice: "Merge" });
        const log = () => (existsSync(codex.log) ? readFileSync(codex.log, "utf8") : "");
        if (row.prompt) {
          // The daemon never answers a steer, so the agent queues after 5 s (#1584).
          await until(() => log().endsWith("\n"), 15_000);
        } else {
          await until(() => ctx.store.state().answers[id] !== undefined, 10_000);
          // A delivery starts as the answer comes in; give it the time a queue takes above.
          await Bun.sleep(row.daemon ? 6_000 : 1_000);
        }
        expect(
          log()
            .split("\n")
            .filter((l) => l.includes(id)),
        ).toHaveLength(row.prompt ? 1 : 0);
      } finally {
        if (row.daemon) await codex.close();
      }
    },
  );

/**
 * A Codex home whose daemon speaks the control socket's protocol: the thread's latest turn has
 * `status`, and `steered` holds each `turn/steer` it took. Its `codex` logs as `codexHome`'s.
 */
async function codexDaemon(status: "inProgress" | "completed", replyAfter = 0) {
  const codex = await codexHome();
  await codex.close();
  const steered: unknown[] = [];
  const daemon = Bun.serve({
    unix: join(codex.env.CODEX_HOME, "app-server-control", "app-server-control.sock"),
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, text) {
        const m = JSON.parse(String(text));
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }));
        if (m.method === "initialize") reply({});
        if (m.method === "thread/turns/list") reply({ data: [{ id: "turn1", items: [], status }] });
        if (m.method === "turn/steer") {
          steered.push(m.params);
          setTimeout(() => reply({ turnId: "turn1" }), replyAfter);
        }
      },
    },
  });
  return { ...codex, steered, close: async () => daemon.stop(true) };
}

for (const status of ["inProgress", "completed"] as const)
  test.skipIf(WINDOWS)(
    `an answer to a card not marked waiting ${status === "inProgress" ? "steers into a Codex session's running turn" : "queues when no Codex turn runs"} (#1486, #1584)`,
    async () => {
      const { ctx, socket } = await machine();
      const codex = await codexDaemon(status);
      trustCodex(ctx, codex.env.CODEX_HOME);
      const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env });
      try {
        const id = await ask(c, "--project", "p");
        await server.answer(id, { choice: "Merge" });
        const log = () => (existsSync(codex.log) ? readFileSync(codex.log, "utf8") : "");
        await until(() => codex.steered.length > 0 || log().endsWith("\n")).catch(() => {});
        if (status === "inProgress") {
          // The socket is the owner's alone, so the steer carries the answer itself.
          expect(codex.steered).toEqual([
            {
              threadId: "t1",
              expectedTurnId: "turn1",
              input: [
                {
                  type: "text",
                  text: `Answer to ${id} (Merge #12 now?): Merge`,
                  text_elements: [],
                },
              ],
            },
          ]);
          expect(log()).toBe("");
        } else {
          expect(codex.steered).toEqual([]);
          expect(log()).toContain(
            `queue --thread t1 --message Starbridge has the owner's answer to ${id}`,
          );
        }
      } finally {
        await codex.close();
      }
    },
  );

test.skipIf(WINDOWS)(
  "the answers waiting for a Codex session steer into its turn as one message (#1597)",
  async () => {
    const { ctx, socket, agent } = await machine();
    const codex = await codexDaemon("inProgress");
    trustCodex(ctx, codex.env.CODEX_HOME);
    const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env });
    try {
      const d1 = await ask(c, "--project", "p");
      const d2 = await ask(c, "--project", "p", "--question", "Deploy tonight?");
      // Both come in while the agent is down, as after a restart.
      await agent.stop();
      await server.answer(d1, { choice: "Merge" });
      await server.answer(d2, { choice: "Wait" });
      const again = makeAgent(ctx, { socket });
      await again.start();
      agents.push(again);
      await until(() => codex.steered.length > 0, 10_000);
      await Bun.sleep(500);
      expect(codex.steered).toHaveLength(1);
      expect((codex.steered[0] as { input: { text: string }[] }).input[0]?.text).toBe(
        `Answer to ${d1} (Merge #12 now?): Merge\nAnswer to ${d2} (Deploy tonight?): Wait`,
      );
    } finally {
      await codex.close();
    }
  },
);

test.skipIf(WINDOWS)(
  "a steer the daemon took but answers late is not queued too (#1486)",
  async () => {
    const { ctx, socket } = await machine();
    const codex = await codexDaemon("inProgress", 7_000);
    trustCodex(ctx, codex.env.CODEX_HOME);
    const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env });
    try {
      const id = await ask(c, "--project", "p", "--waiting");
      await server.answer(id, { choice: "Merge" });
      await until(() => codex.steered.length > 0);
      await Bun.sleep(8_000);
      expect(codex.steered).toHaveLength(1);
      expect(existsSync(codex.log)).toBe(false);
    } finally {
      await codex.close();
    }
  },
);

test("the agent sends an Antigravity conversation's answer through its language server (#961)", async () => {
  const { socket } = await machine();
  const calls: { method: string; token: string | null; body: unknown }[] = [];
  const ls = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return Response.json({ status: "ok" });
      const method = url.pathname.split("/").at(-1) as string;
      calls.push({
        method,
        token: req.headers.get("x-codeium-csrf-token"),
        body: await req.json(),
      });
      if (method === "GetCascadeTrajectoryGeneratorMetadata")
        return Response.json({ generatorMetadata: [{ chatModel: { model: "MODEL_A" } }, {}] });
      return Response.json({});
    },
  });
  try {
    const env = {
      STARBRIDGE_AGENT_SOCKET: socket,
      ANTIGRAVITY_CONVERSATION_ID: "c-1",
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${ls.port}`,
      ANTIGRAVITY_CSRF_TOKEN: "tok",
    };
    const c = testCtx(env);
    const id = await ask(c, "--project", "p");
    expect(c.errors.at(-1)).toBe("The answer will come back into this session as a new prompt.");
    await server.answer(id, { choice: "Merge" });
    await until(() => calls.some((x) => x.method === "SendUserCascadeMessage"));
    expect(calls.at(-1)).toEqual({
      method: "SendUserCascadeMessage",
      token: "tok",
      body: {
        cascadeId: "c-1",
        items: [{ text: `Answer to ${id} (Merge #12 now?): Merge` }],
        deliveryStrategy: "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE",
        cascadeConfig: { plannerConfig: { planModel: "MODEL_A" } },
      },
    });
    // Its token goes to loopback only: a server elsewhere gets no route, and the line says wait.
    const away = testCtx({ ...env, ANTIGRAVITY_LS_ADDRESS: `example.com:${ls.port}` });
    await ask(away, "--project", "p");
    expect(away.errors.at(-1)).toContain("run `starbridge wait");
  } finally {
    ls.stop(true);
  }
});

test("the answers waiting for an Antigravity conversation go as one message (#1597)", async () => {
  const { ctx, socket, agent } = await machine();
  const texts: string[] = [];
  const ls = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return Response.json({ status: "ok" });
      const body = (await req.json()) as { items?: { text: string }[] };
      if (url.pathname.endsWith("/SendUserCascadeMessage")) texts.push(body.items?.[0]?.text ?? "");
      if (url.pathname.endsWith("/GetCascadeTrajectoryGeneratorMetadata"))
        return Response.json({ generatorMetadata: [{ chatModel: { model: "MODEL_A" } }] });
      return Response.json({});
    },
  });
  try {
    const c = testCtx({
      STARBRIDGE_AGENT_SOCKET: socket,
      ANTIGRAVITY_CONVERSATION_ID: "c-1",
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${ls.port}`,
      ANTIGRAVITY_CSRF_TOKEN: "tok",
    });
    const d1 = await ask(c, "--project", "p");
    const d2 = await ask(c, "--project", "p", "--question", "Deploy tonight?");
    // Both come in while the agent is down, as after a restart.
    await agent.stop();
    await server.answer(d1, { choice: "Merge" });
    await server.answer(d2, { choice: "Wait" });
    const again = makeAgent(ctx, { socket });
    await again.start();
    agents.push(again);
    await until(() => texts.length > 0, 10_000);
    await Bun.sleep(500);
    expect(texts).toEqual([
      `Answer to ${d1} (Merge #12 now?): Merge\nAnswer to ${d2} (Deploy tonight?): Wait`,
    ]);
  } finally {
    ls.stop(true);
  }
});

test("the Stop hook leaves an answer the agent sends through the language server to it, so it arrives once (#1278)", async () => {
  const { ctx, socket } = await machine();
  const sent: string[] = [];
  // A language server that takes the connection but fails each send: the answer stays queued.
  const ls = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return Response.json({ status: "ok" });
      if (url.pathname.endsWith("/SendUserCascadeMessage")) {
        sent.push(url.pathname);
        return new Response("busy", { status: 503 });
      }
      if (url.pathname.endsWith("/GetCascadeTrajectoryGeneratorMetadata"))
        return Response.json({ generatorMetadata: [{ chatModel: { model: "MODEL_A" } }] });
      return Response.json({});
    },
  });
  try {
    ctx.env = {
      ...ctx.env,
      STARBRIDGE_AGENT_SOCKET: socket,
      ANTIGRAVITY_CONVERSATION_ID: "c-1",
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${ls.port}`,
      ANTIGRAVITY_CSRF_TOKEN: "tok",
    };
    const id = await ask(ctx, "--project", "p");
    await server.answer(id, { choice: "Merge" });
    await until(() => sent.length > 0);
    ctx.lines.length = 0;
    expect(
      await hookStop(ctx, JSON.stringify({ conversationId: "c-1" }), { agent: "antigravity" }),
    ).toBe(0);
    expect(ctx.lines).toEqual([]);
  } finally {
    ls.stop(true);
  }
});

test.skipIf(WINDOWS)(
  "a Codex session the agent cannot reach is told to wait, and its wait gets the answer",
  async () => {
    const { ctx, socket } = await machine();
    const codex = await codexHome(true);
    trustCodex(ctx, codex.env.CODEX_HOME);
    const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env });
    try {
      const id = await ask(c, "--project", "p");
      await codex.close();
      const asked = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...codex.env });
      await ask(asked, "--project", "p");
      expect(asked.errors.at(-1)).toContain("run `starbridge wait");

      // The queue fails, so the answer stays for the session's wait.
      await server.answer(id, { choice: "Wait" });
      await until(async () => existsSync(codex.log));
      expect(await run(["wait", id, "--timeout", "10s"], c)).toBe(0);
      expect(c.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Wait`);
    } finally {
      await codex.close().catch(() => {});
    }
  },
);

test("a Pi session with the extension gets its answer as an event, titled from its file", async () => {
  const { socket } = await machine();
  const dir = mkdtempSync(join(tmpdir(), "starbridge-pi-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", id: "p1" })}\n${JSON.stringify({ type: "session_info", name: "Fix the build" })}\n`,
  );
  const pi = { PI_SESSION_ID: "p1", PI_SESSION_FILE: file, CLAUDE_CODE_SESSION_ID: "c1" };
  const c = testCtx({ STARBRIDGE_AGENT_SOCKET: socket, ...pi, STARBRIDGE_PI_ANSWERS: "p1" });
  const id = await ask(c, "--project", "p");
  expect(c.errors.at(-1)).toBe("The answer will come back into this session as a new prompt.");
  const [d] = await server.opened("decision");
  expect([d?.agent, d?.source.session, d?.source.sessionTitle]).toEqual([
    "pi",
    "p1",
    "Fix the build",
  ]);

  const s = session(socket, "p1");
  await s.hello();
  await server.answer(id, { choice: "Merge" });
  await until(async () => (await s.events()).length === 1);
  expect((await s.events())[0]?.line).toBe(`Answer to ${id} (Merge #12 now?): Merge`);

  // Without the extension (`pi -p`, or not installed), nothing brings the answer back, even in a
  // `pi -p` that inherited another session's variable.
  const bare = testCtx({
    STARBRIDGE_AGENT_SOCKET: socket,
    ...pi,
    PI_SESSION_ID: "p2",
    STARBRIDGE_PI_ANSWERS: "p1",
  });
  await ask(bare, "--project", "p");
  expect(bare.errors.at(-1)).toContain("run `starbridge wait");
});

test("an opencode session with the plugin gets its answer as an event, titled by the plugin", async () => {
  const { ctx, socket } = await machine();
  const oc = {
    STARBRIDGE_OPENCODE_SESSION: "ses_1",
    STARBRIDGE_OPENCODE_TITLE: "Fix the build",
    CLAUDE_CODE_SESSION_ID: "c1",
  };
  const c = testCtx({
    STARBRIDGE_AGENT_SOCKET: socket,
    ...oc,
    STARBRIDGE_OPENCODE_ANSWERS: "ses_1",
  });
  const id = await ask(c, "--project", "p");
  expect(c.errors.at(-1)).toBe("The answer will come back into this session as a new prompt.");
  const [d] = await server.opened("decision");
  expect([d?.agent, d?.source.session, d?.source.sessionTitle]).toEqual([
    "opencode",
    "ses_1",
    "Fix the build",
  ]);

  const s = session(socket, "ses_1");
  await s.hello();
  await server.answer(id, { choice: "Merge" });
  await until(async () => (await s.events()).length === 1);
  expect((await s.events())[0]?.line).toBe(`Answer to ${id} (Merge #12 now?): Merge`);

  // `opencode run`, started from another session's shell, inherits that session's variable.
  const run = testCtx({
    STARBRIDGE_AGENT_SOCKET: socket,
    ...oc,
    STARBRIDGE_OPENCODE_SESSION: "ses_2",
    STARBRIDGE_OPENCODE_ANSWERS: "ses_1",
  });
  const waits = await ask(run, "--project", "p");
  expect(run.errors.at(-1)).toContain("run `starbridge wait");
  // What the plugin reads after a restart to resume only the sessions expecting a prompt (#398).
  const asked = ctx.store.state().asked;
  expect([asked[id]?.extensionAnswers, asked[waits]?.extensionAnswers]).toEqual([true, undefined]);
});

const PROMPT = "The answer will come back into this session as a new prompt.";

/** A Cursor hook's input for conversation `conv`, each a turn of its own. */
let turns = 0;
const cursorHook = (event: string, conv: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: event,
    conversation_id: conv,
    generation_id: `g-${++turns}`,
    cursor_version: "2026.10.01",
    ...extra,
  });

test("Cursor: the stop hook holds for the answer and returns it as the next prompt (#956)", async () => {
  const { ctx, socket } = await machine();
  const c = testCtx({
    STARBRIDGE_AGENT_SOCKET: socket,
    CURSOR_AGENT: "1",
    CURSOR_CONVERSATION_ID: "conv-1",
  });
  // Until the plugin's sessionStart hook ran, nothing says a hold takes the answer.
  const before = await ask(c, "--project", "p");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");
  expect(
    await run(
      ["settle", before, "--outcome", "withdrawn", "--reason", "Asked again once the hook ran"],
      ctx,
    ),
  ).toBe(0);
  ctx.lines.length = 0;
  expect(await hookCursorSession(ctx, cursorHook("sessionStart", "conv-1"))).toBe(0);
  const id = await ask(c, "--project", "p");
  expect(c.errors.at(-1)).toBe(PROMPT);

  // A turn the owner stopped holds nothing.
  await hookCursorSession(ctx, cursorHook("stop", "conv-1", { status: "aborted" }));
  expect(ctx.lines).toEqual([]);
  const stop = hookCursorSession(ctx, cursorHook("stop", "conv-1", { status: "completed" }));
  await server.answer(id, { choice: "Merge" });
  expect(await stop).toBe(0);
  expect(ctx.lines.map((l) => JSON.parse(l))).toEqual([
    { followup_message: `Answer to ${id} (Merge #12 now?): Merge` },
  ]);
  // Cursor runs each stop hook twice at once: only one holds.
  const twice = cursorHook("stop", "conv-1", { status: "completed" });
  const id2 = await ask(c, "--project", "p");
  const both = [hookCursorSession(ctx, twice), hookCursorSession(ctx, twice)];
  await server.answer(id2, { choice: "Wait" });
  await Promise.all(both);
  expect(ctx.lines.slice(1).map((l) => JSON.parse(l))).toEqual([
    { followup_message: `Answer to ${id2} (Merge #12 now?): Wait` },
  ]);
  ctx.lines.length = 1;
  // Taken: the next stop has nothing to hold for.
  await hookCursorSession(ctx, cursorHook("stop", "conv-1", { status: "completed" }));
  expect(ctx.lines).toHaveLength(1);

  // After sessionEnd, the conversation is gone.
  await hookCursorSession(ctx, cursorHook("sessionEnd", "conv-1"));
  await ask(c, "--project", "p");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");
});

test("Cursor: past the hold's cap the agent is told to wait; without an agent the hold reads the server (#956)", async () => {
  const { ctx, socket } = await machine();
  const c = testCtx({
    STARBRIDGE_AGENT_SOCKET: socket,
    CURSOR_AGENT: "1",
    CURSOR_CONVERSATION_ID: "conv-2",
  });
  const id = await ask(c, "--project", "p");
  let calls = 0;
  const late = { ...ctx, now: () => new Date(Date.now() + (calls++ > 0 ? 11 * 60_000 : 0)) };
  await hookCursorSession(late, cursorHook("stop", "conv-2", { status: "completed" }));
  expect(JSON.parse(ctx.lines.at(-1) as string).followup_message).toBe(
    `No answer yet to ${id} (Merge #12 now?). Nothing brings the answer into this session: when only the answer is left, run \`starbridge wait ${id} --timeout 5m\` (again on exit 2).`,
  );

  const direct = { ...ctx, env: { ...ctx.env, STARBRIDGE_NO_AGENT: "1" } };
  ctx.lines.length = 0;
  // A server error mid-hold is retried, not the end of the hold.
  server.failures.push("/answers");
  const stop = hookCursorSession(direct, cursorHook("stop", "conv-2", { status: "completed" }));
  await server.answer(id, { choice: "Wait" });
  await stop;
  expect(ctx.lines.map((l) => JSON.parse(l))).toEqual([
    { followup_message: `Answer to ${id} (Merge #12 now?): Wait` },
  ]);
  expect(ctx.store.state().answers[id]?.seen).toBe(true);
});

// Unix sockets only: on Windows the agent listens on loopback TCP.
test.skipIf(WINDOWS)(
  "the socket is never open to other users, even between bind and chmod (#95)",
  async () => {
    const ctx = await paired(server);
    ctx.env.STARBRIDGE_CODEXBAR = FAKE_CODEXBAR;
    const socket = join(ctx.store.dir, "agent.sock");
    // The mode the socket has the moment it can take connections, before start() returns.
    let bound: number | undefined;
    const listen = HttpServer.prototype.listen;
    HttpServer.prototype.listen = function (this: HttpServer, ...args: unknown[]) {
      const done = args.pop() as () => void;
      return listen.call(this, ...(args as []), () => {
        try {
          bound = statSync(socket).mode & 0o777;
        } finally {
          done();
        }
      });
    } as typeof listen;
    const umask = process.umask(0o002);
    try {
      const agent = makeAgent(ctx, { socket });
      await agent.start();
      agents.push(agent);
    } finally {
      HttpServer.prototype.listen = listen;
      process.umask(umask);
    }
    expect(bound).toBeDefined();
    expect((bound as number) & 0o077).toBe(0);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(process.umask()).toBe(umask);
  },
);

test.skipIf(!WINDOWS)(
  "on Windows, an agent whose port file icacls cannot restrict does not serve (#1209)",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "starbridge-port-"));
    const socket = join(dir, "agent.port");
    const fakes = dirname(compiledFake('console.error("access denied"); process.exit(5);'));
    copyFileSync(join(fakes, "fake.exe"), join(fakes, "icacls.exe"));
    const path = process.env.PATH;
    process.env.PATH = `${fakes};${path}`;
    try {
      await expect(machine({ socket })).rejects.toThrow(
        "readable by this user only, so the agent does not serve: access denied",
      );
    } finally {
      process.env.PATH = path;
    }
    expect(readdirSync(dir)).toEqual([]);
  },
);

test("on loopback TCP (Windows), only a call that proves the port file's token gets through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starbridge-port-"));
  const socket = join(dir, "agent.port");
  const { agent } = await machine({ socket });
  if (!WINDOWS) expect(statSync(socket).mode & 0o777).toBe(0o600);
  const file = JSON.parse(readFileSync(socket, "utf8"));
  expect(file.pid).toBe(process.pid);

  await ask(client(socket), "--project", "p");
  expect(await server.opened("decision")).toHaveLength(1);

  const call = (headers: Record<string, string>) =>
    new Promise<{ status: number; proof: unknown }>((resolve, reject) =>
      request({ host: "127.0.0.1", port: file.port, path: "/v1/status", headers }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, proof: res.headers["starbridge-proof"] });
      })
        .on("error", reject)
        .end(),
    );
  const nonce = "0".repeat(32);
  const api = { "starbridge-api": "1", "starbridge-nonce": nonce };
  expect((await call(api)).status).toBe(401);
  expect((await call({ ...api, authorization: `Bearer ${file.token}` })).status).toBe(401);
  expect(
    await call({ ...api, authorization: `Starbridge ${proof(file.token, "client", nonce)}` }),
  ).toEqual({ status: 200, proof: proof(file.token, "agent", nonce) });

  await agent.stop();
  expect(existsSync(socket)).toBe(false);

  // Whatever takes the port after the agent stopped cannot answer for it.
  const impostor = createServer((_req, res) => res.end("{}"));
  await new Promise<void>((r) => impostor.listen(file.port, "127.0.0.1", r));
  writeFileSync(socket, JSON.stringify(file));
  try {
    expect((await rejection(new AgentClient(socket).call("GET", "/v1/status"))).message).toContain(
      "proof",
    );
  } finally {
    impostor.close();
  }
  // A port file left by an agent that died: its pid runs no more, so nothing is sent.
  writeFileSync(socket, JSON.stringify({ ...file, pid: 2 ** 22 + 1 }));
  expect((await rejection(new AgentClient(socket).call("GET", "/v1/status"))).message).toContain(
    "no agent",
  );
});

test("an agent that hangs up or exits without stopping removes its port file (#570)", async () => {
  const main = join(import.meta.dir, "../src/main.ts");
  // An exit that skips the agent's stop, as a fatal error's does, once the agent wrote its file.
  const exit = `process.argv = [process.argv[0], "starbridge", "agent", "--no-quota"];
const { existsSync } = await import("node:fs");
setInterval(() => existsSync(process.env.STARBRIDGE_AGENT_SOCKET) && process.exit(1), 5);
await import(${JSON.stringify(main)});`;
  // Windows has no SIGHUP.
  for (const how of WINDOWS ? (["exit"] as const) : (["SIGHUP", "exit"] as const)) {
    const dir = mkdtempSync(join(tmpdir(), "starbridge-port-"));
    const socket = join(dir, "agent.port");
    const argv = how === "exit" ? ["-e", exit] : [main, "agent", "--no-quota"];
    const child = Bun.spawn([process.execPath, ...argv], {
      env: {
        ...process.env,
        HOME: dir,
        STARBRIDGE_CONFIG_DIR: dir,
        STARBRIDGE_AGENT_SOCKET: socket,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // The exit comes once the file is there; SIGHUP as soon as it is, which the agent must
      // catch from before it writes the file.
      if (how === "SIGHUP") {
        await until(() => existsSync(socket), 10_000);
        child.kill("SIGHUP");
      }
      expect(await child.exited).toBe(how === "SIGHUP" ? 0 : 1);
      expect(existsSync(socket)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }
});

test("answers --all through the agent follows every session's answers and takes none", async () => {
  const { socket } = await machine();
  const c = client(socket);
  const s1 = session(socket, "s1");
  await s1.hello();
  const first = await ask(c, "--project", "p", "--session", "s1");
  await server.answer(first, { choice: "Merge" });
  await until(async () => (await s1.events()).length === 1);

  const controller = new AbortController();
  const observer = { ...client(socket), signal: controller.signal };
  const following = run(["answers", "--all", "--follow"], observer);
  await until(() => observer.lines.length === 1);
  expect(JSON.parse(observer.lines[0] as string)).toMatchObject({
    decisionId: first,
    question: "Merge #12 now?",
    choice: "Merge",
    session: "s1",
    project: "p",
  });
  const second = await ask(c, "--project", "q", "--session", "s2");
  await server.answer(second, { choice: "Wait" });
  await until(() => observer.lines.length === 2);
  expect(JSON.parse(observer.lines[1] as string)).toMatchObject({
    decisionId: second,
    project: "q",
  });
  controller.abort();
  expect(await following).toBe(130);

  // Still each session's to take, and nothing went waiting.
  expect((await s1.events()).map((e) => e.decisionId)).toEqual([first]);
  expect(await run(["wait", second, "--timeout", "1s"], c)).toBe(0);
  expect(await server.opened("waiting")).toEqual([]);
});

test("ask promises a prompt only once the agent has seen this session's mod (#537)", async () => {
  const { socket, ctx } = await machine();
  const c = client(socket);
  c.env.CLAUDECODE = "1";
  const prompt = "The answer will come back into this session as a new prompt.";
  await ask(c, "--session", "s-mod");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");

  const s = session(socket, "s-mod");
  await s.events();
  await ask(c, "--session", "s-mod");
  expect(c.errors.at(-1)).toBe(prompt);
  // Another session's mod is no promise for this one.
  await ask(c, "--session", "s-other");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");

  // A /clear: the same process greets under a new id, and the old one has no mod any more.
  const http = new AgentClient(socket, "starbridge-mod/test");
  await http.call("POST", "/v1/sessions/s-cleared/hello", { cwd: "/work/x", replaces: "s-mod" });
  await ask(c, "--session", "s-mod");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");
  await ask(c, "--session", "s-cleared");
  expect(c.errors.at(-1)).toBe(prompt);

  await s.events();
  await s.bye();
  await ask(c, "--session", "s-mod");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");

  // A mod silent for longer than one events cycle no longer counts.
  await session(socket, "s-quiet").events();
  const start = Date.now();
  ctx.now = () => new Date(start + 46_000);
  await ask(c, "--session", "s-quiet");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");
});

test("an Agent SDK session, unattended to Claude Code, gets a prompt once its mod is seen (#2100)", async () => {
  const { socket } = await machine();
  const c = client(socket);
  // An app that runs Claude Code through the Agent SDK: unattended, as `claude -p` is.
  c.env.CLAUDECODE = "1";
  c.env.CLAUDE_CODE_SESSION_ATTENDED = "0";
  await ask(c, "--session", "s-t3");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");
  // The mod runs its loop there once the first turn ended, as it never does in `claude -p`.
  await session(socket, "s-t3").events();
  await ask(c, "--session", "s-t3");
  expect(c.errors.at(-1)).toBe("The answer will come back into this session as a new prompt.");
});

test("through the agent, wait --no-mark leaves the decision as it was (#603)", async () => {
  const { socket } = await machine();
  const c = client(socket);
  const id = await ask(c, "--project", "p");
  expect(await run(["wait", id, "--no-mark", "--timeout", "1s"], c)).toBe(2);
  expect(await server.opened("waiting")).toEqual([]);
  expect(await run(["wait", id, "--timeout", "1s"], c)).toBe(2);
  expect((await server.opened("waiting")).map((w) => w.state)).toEqual(["waiting"]);
});

// Unix sockets only: on Windows the agent listens on loopback TCP.
test.skipIf(WINDOWS)(
  "a socket path too long for a unix socket: clients fall back and say why (#622)",
  async () => {
    const ctx = await paired(server);
    const socket = join(ctx.store.dir, "x".repeat(120), "agent.sock");
    const call = new AgentClient(socket).call("GET", "/v1/status");
    await expect(call).rejects.toBeInstanceOf(NoAgent);
    await expect(call).rejects.toThrow("too long for a unix socket");

    // Bun's agent listens there and says so in a pid file, which goes when it stops (#714).
    const first = makeAgent(ctx, { socket, noQuota: true });
    await first.start();
    agents.push(first);
    expect(readFileSync(`${socket}.pid`, "utf8")).toBe(String(process.pid));
    // Where `connect` refuses the path (Node, macOS), a second agent cannot probe the first: the
    // pid file stops it from unlinking the live socket.
    const probe = spyOn(AgentClient.prototype, "call").mockRejectedValueOnce(
      new NoAgent("too long", "EINVAL"),
    );
    // The first agent as another process sees it.
    const other = Bun.spawn(["sleep", "30"]);
    writeFileSync(`${socket}.pid`, String(other.pid));
    try {
      await expect(makeAgent(ctx, { socket, noQuota: true }).start()).rejects.toThrow(
        "already runs",
      );
    } finally {
      probe.mockRestore();
    }
    expect(existsSync(socket)).toBe(true);
    writeFileSync(`${socket}.pid`, String(process.pid));
    await first.stop();
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(`${socket}.pid`)).toBe(false);
    // The CLI goes to the server itself where it cannot connect, and says why.
    writeFileSync(socket, "");
    const env = { ...ctx.env, STARBRIDGE_AGENT_SOCKET: socket };
    expect(await run([...ASK, "--session", "s1"], { ...ctx, env })).toBe(0);
    expect(ctx.errors.some((e) => e.includes("too long for a unix socket"))).toBe(true);
    rmSync(socket);

    // After a crash, a probe that finds no socket proves the agent gone, whatever process has its
    // pid now.
    try {
      writeFileSync(`${socket}.pid`, String(other.pid));
      const again = makeAgent(ctx, { socket, noQuota: true });
      await again.start();
      await again.stop();
    } finally {
      other.kill();
    }
  },
);

test("a session not heard from for a day drops out of the agent's list (#1763)", async () => {
  const { ctx, socket } = await machine();
  const http = new AgentClient(socket, "starbridge-mod/test");
  await http.call("POST", "/v1/sessions/s-old/hello", { cwd: "/work/x", pid: 42 });
  // A Cursor conversation's hooks greet it without a pid, and nothing else ever polls for it.
  await http.call("POST", "/v1/sessions/conv-1/hello", { cwd: "/work/x" });
  const ids = async () =>
    (await http.call<{ sessions: { id: string }[] }>("GET", "/v1/status")).sessions.map(
      (x) => x.id,
    );
  expect(await ids()).toEqual(["s-old", "conv-1"]);
  const start = Date.now();
  ctx.now = () => new Date(start + 25 * 3_600_000);
  expect(await ids()).toEqual(["conv-1"]);
});

test("Cursor: follow-ups that bring no answer stop after three per conversation (#1763)", () => {
  const ctx = testCtx();
  for (let i = 0; i < MAX_EMPTY_FOLLOWUPS; i++)
    expect(countFollowup(ctx, "conv-1", true)).toBe(true);
  expect(countFollowup(ctx, "conv-1", true)).toBe(false);
  // Another conversation has its own count, and an answer clears this one's.
  expect(countFollowup(ctx, "conv-2", true)).toBe(true);
  expect(countFollowup(ctx, "conv-1", false)).toBe(true);
  expect(countFollowup(ctx, "conv-1", true)).toBe(true);
});
