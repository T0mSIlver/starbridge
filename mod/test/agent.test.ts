import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { socketPath as cliSocketPath } from "../../cli/src/agent/api";
import { makeAgent } from "../../cli/src/agent/main";
import type { Agent } from "../../cli/src/agent/server";
import { run } from "../../cli/src/cli";
import { paired, type TestCtx, until } from "../../cli/test/helpers";
import {
  type AgentHost,
  AgentLoop,
  type AgentTiming,
  HEADERS,
  type Reply,
  socketPath,
} from "../hooks/agent.ts";
import { socketFetch } from "../hooks/node.ts";
import { Poller, type Timing } from "../hooks/poller.ts";
import { Switch } from "../hooks/switch.ts";

setDefaultTimeout(20_000);

const FAST: AgentTiming = { waitSeconds: 1, minCycleMs: 20, backoffMs: 20, maxBackoffMs: 160 };
const FAST_CLI: Timing = {
  waitSeconds: 1,
  checkMs: 10,
  recheckMs: 60_000,
  leaseMs: 2_000,
  minCycleMs: 20,
  backoffMs: 20,
  maxBackoffMs: 160,
};

let server: LiveServer;
let cli: TestCtx;
let socket: string;
let agent: Agent | undefined;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  server = await LiveServer.start();
  cli = await paired(server);
  socket = join(cli.store.dir, "agent.sock");
  agent = undefined;
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await agent?.stop();
  server.stop();
});

async function startAgent() {
  agent = makeAgent(cli, { socket, noQuota: true });
  await agent.start();
}

/** `$.http.fetch` with `socketPath`, as the host runs it: rejects when it cannot connect. */
function fetchOn(path: string, method: string, body?: unknown): Promise<Reply> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        agent: false,
        path,
        method,
        headers: text === undefined ? HEADERS : { ...HEADERS, "content-type": "application/json" },
        timeout: 30_000,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          raw += d;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: raw }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("aborted after 30 s")));
    req.on("error", reject);
    req.end(text);
  });
}

/** A session with the mod: the engine's `$` reduced to what the loops use. */
function session(id: string) {
  const s = {
    id,
    submitted: [] as string[],
    calls: [] as string[],
    status: undefined as string | undefined,
    logs: [] as string[],
    /** Called when a call returns, before the loop sees its reply. */
    afterCall: undefined as ((path: string) => void) | undefined,
    reply: undefined as ((path: string) => Reply | undefined) | undefined,
  };
  const host: AgentHost = {
    sessionId: async () => s.id,
    cwd: async () => "/work/x",
    fetch: async (method, path, body) => {
      s.calls.push(`${method} ${path}`);
      const r = s.reply?.(path) ?? (await fetchOn(path, method, body));
      s.afterCall?.(path);
      return r;
    },
    now: async () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    submit: (text) => {
      s.submitted.push(text);
    },
    status: (text) => {
      s.status = text;
    },
    log: (text) => s.logs.push(text),
  };
  return { s, host };
}

async function ask(question: string, sessionId: string): Promise<string> {
  const args = ["ask", "--question", question, "--option", "Yes", "--option", "No"];
  expect(await run([...args, "--session", sessionId], cli)).toBe(0);
  return cli.lines.at(-1) as string;
}

function loop(host: AgentHost) {
  const l = new AgentLoop(host, new Set(), FAST);
  const done = l.run();
  stops.push(async () => {
    l.stop();
    await done;
  });
  return { loop: l, done };
}

test("the mod finds the socket where the CLI's agent listens", () => {
  // The CLI reads the home directory from the OS, the mod from $HOME: the same in a session.
  const HOME = homedir();
  const cases: Record<string, string>[] = [
    { HOME },
    { HOME, XDG_RUNTIME_DIR: "/run/user/1000" },
    { HOME, XDG_RUNTIME_DIR: "/run/user/1000", XDG_CONFIG_HOME: "/cfg" },
    { HOME, XDG_RUNTIME_DIR: "/run/user/1000", STARBRIDGE_CONFIG_DIR: "/tmp/sb" },
    {
      HOME,
      XDG_RUNTIME_DIR: "/run/user/1000",
      STARBRIDGE_CONFIG_DIR: `${HOME}/.config/starbridge`,
    },
    { HOME, STARBRIDGE_AGENT_SOCKET: "/s.sock" },
  ];
  for (const env of cases) {
    const dir =
      env.STARBRIDGE_CONFIG_DIR ?? `${env.XDG_CONFIG_HOME ?? `${env.HOME}/.config`}/starbridge`;
    expect(socketPath(env)).toBe(cliSocketPath(env, dir));
  }
});

test("on Windows the mod finds the agent's port file where the CLI writes it", () => {
  const env = { USERPROFILE: "C:/Users/tom", OS: "Windows_NT" };
  const dir = "C:/Users/tom/.config/starbridge";
  expect(socketPath(env)).toBe(`${dir}/agent.port`);
  expect(cliSocketPath(env, dir, "win32").replace(/\\/g, "/")).toBe(`${dir}/agent.port`);
});

test("the Node fetch of Pi and opencode reaches an agent on loopback TCP", async () => {
  socket = join(cli.store.dir, "agent.port");
  await startAgent();
  const r = await socketFetch(socket, "GET", "/v1/status");
  expect(r.status).toBe(200);
  expect(JSON.parse(r.text).socket).toBe(socket);
});

test("an answer the host refuses stays unconfirmed and comes back", async () => {
  await startAgent();
  const a = session("s-a");
  let refuse = true;
  const tries: string[] = [];
  loop({
    ...a.host,
    submit: async (text) => {
      tries.push(text);
      if (refuse) return false;
      a.s.submitted.push(text);
      return true;
    },
  });
  const d = await ask("Merge #12 now?", "s-a");
  await until(() => a.s.calls.some((c) => c.startsWith("GET")));
  await server.answer(d, { choice: "No" });
  await until(() => tries.length >= 1);
  expect(a.s.calls).not.toContain("POST /v1/sessions/s-a/ack");
  refuse = false;
  await until(() => a.s.submitted.length === 1);
  await until(() => a.s.calls.includes("POST /v1/sessions/s-a/ack"));
  expect(a.s.submitted).toEqual([`Answer to ${d} (Merge #12 now?): No`]);
});

test("each session gets its own answers through the agent, once, confirmed", async () => {
  await startAgent();
  const a = session("s-a");
  const b = session("s-b");
  loop(a.host);
  loop(b.host);
  const da = await ask("Merge #12 now?", "s-a");
  const db = await ask("Deploy tonight?", "s-b");
  await until(() => a.s.calls.some((c) => c.startsWith("GET")));
  await server.answer(da, { choice: "No" });
  await server.answer(db, { choice: "Yes" });
  await until(() => a.s.submitted.length === 1 && b.s.submitted.length === 1);
  expect(a.s.submitted).toEqual([`Answer to ${da} (Merge #12 now?): No`]);
  expect(b.s.submitted).toEqual([`Answer to ${db} (Deploy tonight?): Yes`]);
  await until(() => a.s.calls.includes("POST /v1/sessions/s-a/ack"));
  // Confirmed: the agent hands it over no more, and the session submitted it once.
  const left = await fetchOn("/v1/sessions/s-a/events", "GET");
  expect(JSON.parse(left.text).events).toEqual([]);
  await Bun.sleep(100);
  expect(a.s.submitted).toHaveLength(1);
  expect(a.s.calls[0]).toBe("POST /v1/sessions/s-a/hello");
  // No session ran the CLI: the mod has no `$.process.run` on this path at all.
  expect(a.s.status).toBeUndefined();
});

test("an answer that arrives during a /clear waits for the old session", async () => {
  await startAgent();
  const a = session("s-clear");
  loop(a.host);
  const da = await ask("Merge #12 now?", "s-clear");
  await until(() => a.s.calls.some((c) => c.startsWith("GET")));
  a.s.afterCall = (path) => {
    if (path.includes("/events")) a.s.id = "s-clear-new";
  };
  await server.answer(da, { choice: "Yes" });
  await until(() => a.s.logs.some((l) => l.includes("held back")));
  a.s.afterCall = undefined;
  expect(a.s.submitted).toEqual([]);
  // The hello under the new id retired the old one: no mod promises it an answer now (#537).
  await until(() => agent?.seen("s-clear-new", 45_000) ?? false);
  expect(agent?.seen("s-clear", 45_000)).toBe(false);
  // `/resume` of the old session: it gets the answer then.
  a.s.id = "s-clear";
  await until(() => a.s.submitted.length === 1);
});

test("a 426 ends the agent loop; another error shows and backs off", async () => {
  await startAgent();
  const a = session("s-a");
  a.s.reply = (path) =>
    path.includes("/events")
      ? { status: 502, text: '{"error":"server","detail":"503"}' }
      : undefined;
  loop(a.host);
  await until(() => a.s.status !== undefined);
  expect(a.s.status).toBe("starbridge: 503");
  const before = a.s.calls.length;
  await Bun.sleep(400);
  expect(a.s.calls.length - before).toBeLessThanOrEqual(5);
  a.s.reply = () => ({ status: 426, text: '{"error":"agent-too-old","detail":"update"}' });
  const b = session("s-b");
  b.s.reply = a.s.reply;
  expect(await new AgentLoop(b.host, new Set(), FAST).run()).toBe("unreachable");
});

test("with no agent the CLI path delivers, and the switch follows the agent coming and going", async () => {
  const a = session("s-a");
  const runs: string[][] = [];
  const sw = new Switch(
    {
      agentUp: async () => (await fetchOn("/v1/status", "GET")).status < 300,
      agent: (unconfirmed) => new AgentLoop(a.host, unconfirmed, FAST),
      poller: (unconfirmed) =>
        new Poller(
          {
            sessionId: async () => a.s.id,
            run: async (argv) => {
              runs.push(argv);
              const out: string[] = [];
              const err: string[] = [];
              const exitCode = await run(argv.slice(1), {
                ...cli,
                out: (l) => out.push(l),
                err: (l) => err.push(l),
              });
              return {
                exitCode,
                stdout: out.map((l) => `${l}\n`).join(""),
                stderr: err.join("\n"),
              };
            },
            read: async (p) => readFileSync(p, "utf8"),
            write: async (p, t) => writeFileSync(p, t),
            mtime: async (p) => {
              try {
                return statSync(p).mtimeMs;
              } catch {
                return undefined;
              }
            },
            now: async () => Date.now(),
            sleep: (ms) => Bun.sleep(ms),
            submit: (t) => {
              a.s.submitted.push(t);
            },
            status: () => {},
            log: (t) => a.s.logs.push(t),
          },
          cli.store.dir,
          "starbridge",
          FAST_CLI,
          unconfirmed,
        ),
      sleep: (ms) => Bun.sleep(ms),
      clearStatus: () => {
        a.s.status = undefined;
      },
      log: () => {},
    },
    50,
  );
  stops.push(() => sw.end());

  const d1 = await ask("First?", "s-a");
  await until(() => sw.mode === "cli");
  await server.answer(d1, { choice: "Yes" });
  await until(() => a.s.submitted.length === 1);

  await startAgent();
  await until(() => sw.mode === "agent");
  const d2 = await ask("Second?", "s-a");
  await server.answer(d2, { choice: "No" });
  await until(() => a.s.submitted.length === 2);

  await agent?.stop();
  agent = undefined;
  await until(() => sw.mode === "cli");
  const d3 = await ask("Third?", "s-a");
  await server.answer(d3, { choice: "Yes" });
  await until(() => a.s.submitted.length === 3);
  expect(a.s.submitted).toEqual([
    `Answer to ${d1} (First?): Yes`,
    `Answer to ${d2} (Second?): No`,
    `Answer to ${d3} (Third?): Yes`,
  ]);
  expect(runs.length).toBeGreaterThan(0);
});
