import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, Server as HttpServer, type IncomingMessage, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { PNG } from "pngjs";
import { proof, type SessionEvent, type Status } from "../src/agent/api";
import { AgentClient, AgentError, Interrupted, NoAgent } from "../src/agent/client";
import { makeAgent } from "../src/agent/main";
import type { Agent } from "../src/agent/server";
import { run } from "../src/cli";
import { hookCursorSession } from "../src/hook";
import {
  agentAddress,
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
  await Bun.sleep(200);
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
  expect(await server.opened("decision")).toEqual([]);
});

// Windows uploads no quotas: CodexBar has no build there (SPEC.md, Platforms).
test.skipIf(WINDOWS)("the agent uploads quotas on its timer", async () => {
  const { agent } = await machine({ providers: ["claude", "codex"], interval: "1s" });
  await until(async () => (await server.opened("quota")).length >= 1, 10_000);
  const [snap] = await server.opened("quota");
  expect(snap?.providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
  const status = await new AgentClient(agent.socket).call<Status>("GET", "/v1/status");
  expect(status.quota.providers).toEqual(["claude", "codex"]);
  expect(status.quota.lastPostAt).toBeDefined();
});

/** A device's call to the server. */
async function asDevice(token: string, method: string, path: string) {
  const r = await fetch(`${server.url}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  return (await r.json()) as { items: unknown[]; behind?: number };
}

// Windows uploads no quotas: CodexBar has no build there (SPEC.md, Platforms).
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

test("a malformed path gets 400 and the agent keeps serving", async () => {
  const { socket } = await machine();
  expect(
    await rejection(new AgentClient(socket).call("GET", "/v1/sessions/%zz/events")),
  ).toMatchObject({ status: 400, body: { error: "bad-path" } });
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
async function codexHome(fail = false) {
  const home = mkdtempSync(join(tmpdir(), "starbridge-codex-"));
  mkdirSync(join(home, "app-server-control"));
  const daemon = createNetServer();
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
    const { socket } = await machine();
    const codex = await codexHome();
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
      const log = () => (existsSync(codex.log) ? readFileSync(codex.log, "utf8") : "");
      await until(() => log() === queued).catch(() => {});
      expect(log()).toBe(queued);
      expect(await run(["wait", id, "--timeout", "10s"], c)).toBe(0);
      expect(c.lines.at(-1)).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
    } finally {
      await codex.close();
    }
  },
);

test.skipIf(WINDOWS)(
  "a Codex session the agent cannot reach is told to wait, and its wait gets the answer",
  async () => {
    const { socket } = await machine();
    const codex = await codexHome(true);
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

/** A Cursor hook's input for conversation `conv`. */
const cursorHook = (event: string, conv: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: event,
    conversation_id: conv,
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
  expect(await run(["settle", before, "--outcome", "withdrawn"], ctx)).toBe(0);
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
  const { socket } = await machine();
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
});

test("a mod silent for longer than one events cycle no longer counts (#537)", async () => {
  const { socket, ctx } = await machine();
  const c = client(socket);
  c.env.CLAUDECODE = "1";
  await session(socket, "s-quiet").events();
  const start = Date.now();
  ctx.now = () => new Date(start + 46_000);
  await ask(c, "--session", "s-quiet");
  expect(c.errors.at(-1)).toContain("run `starbridge wait");
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
