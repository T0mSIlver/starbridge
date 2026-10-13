import { expect, test } from "bun:test";

// register.ts imports the engine's types, which CI does not have (README, "Develop"): loaded by
// a path tsc does not follow.
const REGISTER = "../hooks/register.ts";

type Handler = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

test("on a port file, the mod reaches the agent at the port the file names (#1285)", async () => {
  const { register } = (await import(REGISTER)) as {
    register: (on: (event: string, h: Handler) => void) => void;
  };
  const handlers = new Map<string, Handler>();
  register((event, h) => handlers.set(event, h));
  const portFile = JSON.stringify({ port: 47213, token: "t".repeat(32), pid: 4242 });
  const fetched: string[] = [];
  const env: Record<string, string> = { STARBRIDGE_AGENT_SOCKET: "/sb/agent.port", HOME: "/sb" };
  // What the engine's types promise: `$.fs.read(path)` resolves the file's text.
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (path: string) => {
        if (path !== "/sb/agent.port") throw new Error(`no ${path}`);
        return portFile;
      },
      write: async () => {},
      stat: async () => undefined,
    },
    process: { run: async () => ({ exitCode: 0, stdout: "4242\n", stderr: "" }) },
    http: {
      fetch: async (url: string) => {
        fetched.push(url);
        return { status: 503, headers: {}, text: "" };
      },
    },
    ui: { log: () => {}, status: () => {} },
    clock: { now: () => Date.now(), sleep: () => new Promise<void>(() => {}) },
    prompt: { submit: () => {} },
    session: { id: async () => "s1", cwd: async () => "/work" },
  };
  await handlers.get("session.start")?.($, { isInteractive: true }, async () => undefined);
  const by = Date.now() + 5000;
  while (fetched.length === 0 && Date.now() < by) await Bun.sleep(20);
  expect(fetched[0]).toBe("http://127.0.0.1:47213/v1/status");
});

test("mid-turn, the main agent's next tool result carries the answer, and the turn's end submits nothing (#1484)", async () => {
  const { register } = (await import(REGISTER)) as {
    register: (on: (event: string, h: Handler) => void) => void;
  };
  const handlers = new Map<string, Handler>();
  register((event, h) => handlers.set(event, h));
  const line = "Answer to d_1 (Merge #12 now?): No";
  let acked = false;
  const submitted: string[] = [];
  const env: Record<string, string> = { STARBRIDGE_AGENT_SOCKET: "/sb/agent.sock", HOME: "/sb" };
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: { read: async () => "", write: async () => {}, stat: async () => undefined },
    process: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    http: {
      fetch: async (url: string) => {
        if (url.endsWith("/ack")) acked = true;
        const events =
          url.includes("/events") && !acked ? [{ type: "answer", ack: "k1", line }] : [];
        return { status: 200, headers: {}, text: JSON.stringify({ events }) };
      },
    },
    ui: { log: () => {}, status: () => {} },
    clock: { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(Math.min(ms, 5)) },
    prompt: {
      submit: async ({ text }: { text: string }) => {
        submitted.push(text);
      },
    },
    session: { id: async () => "s1", cwd: async () => "/work" },
  };
  const call = (e: object, result: object) =>
    handlers.get("tool.call")?.($, { tool: "Bash", ...e }, async () => result) as Promise<{
      context?: string[];
    }>;
  await handlers.get("turn.start")?.($, { text: "go", turnId: "t1" }, async () => undefined);
  await handlers.get("session.start")?.($, { isInteractive: true }, async () => undefined);
  await Bun.sleep(100);
  expect(submitted).toEqual([]);
  // A subagent's call and a refused call carry nothing; the main agent's next result does.
  expect((await call({ agentId: "a1" }, { result: "ok" })).context).toBeUndefined();
  expect((await call({}, { deny: "no" })).context).toBeUndefined();
  expect((await call({}, { result: "ok" })).context).toEqual([line]);
  expect((await call({}, { result: "ok" })).context).toBeUndefined();
  const by = Date.now() + 5000;
  while (!acked && Date.now() < by) await Bun.sleep(20);
  expect(acked).toBe(true);
  await handlers.get("turn.complete")?.($, { turnId: "t1" }, async () => undefined);
  expect(submitted).toEqual([]);
  await handlers.get("session.end")?.($, { reason: "other" }, async () => undefined);
});
