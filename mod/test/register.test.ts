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
