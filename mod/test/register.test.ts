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
    plugin: { name: "starbridge-mod", root: "/m" },
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

test("an Agent SDK session calls the agent only once its first turn ends; `claude -p` never (#2100)", async () => {
  const run = async (entrypoint: string) => {
    const { register } = (await import(REGISTER)) as {
      register: (on: (event: string, h: Handler) => void) => void;
    };
    const handlers = new Map<string, Handler>();
    register((event, h) => handlers.set(event, h));
    const fetched: string[] = [];
    const env: Record<string, string> = {
      STARBRIDGE_AGENT_SOCKET: "/sb/agent.sock",
      HOME: "/sb",
      CLAUDE_CODE_ENTRYPOINT: entrypoint,
    };
    const $ = {
      env: { get: async (name: string) => env[name] },
      fs: { read: async () => "", write: async () => {}, stat: async () => undefined },
      process: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
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
    await handlers.get("session.start")?.($, { isInteractive: false }, async () => undefined);
    await Bun.sleep(100);
    const atStart = fetched.length;
    // A subagent's end is not the session's turn.
    await handlers.get("turn.complete")?.($, { agentId: "a1" }, async () => undefined);
    await Bun.sleep(100);
    const afterSubagent = fetched.length;
    await handlers.get("turn.complete")?.($, { turnId: "t1" }, async () => undefined);
    const by = Date.now() + 2000;
    while (fetched.length === 0 && Date.now() < by) await Bun.sleep(20);
    await handlers.get("session.end")?.($, { reason: "other" }, async () => undefined);
    return { atStart, afterSubagent, afterTurn: fetched.length };
  };
  const sdk = await run("sdk-ts");
  expect([sdk.atStart, sdk.afterSubagent]).toEqual([0, 0]);
  expect(sdk.afterTurn).toBeGreaterThan(0);
  expect(await run("sdk-cli")).toEqual({ atStart: 0, afterSubagent: 0, afterTurn: 0 });
});

test("mid-turn, the main agent's next tool result carries an answer marked waiting, and the turn's end submits nothing (#1484)", async () => {
  const { register } = (await import(REGISTER)) as {
    register: (on: (event: string, h: Handler) => void) => void;
  };
  const handlers = new Map<string, Handler>();
  register((event, h) => handlers.set(event, h));
  const line = "Answer to d_1 (Merge #12 now?): No";
  let acked = false;
  let turn = false;
  const submitted: string[] = [];
  const env: Record<string, string> = { STARBRIDGE_AGENT_SOCKET: "/sb/agent.sock", HOME: "/sb" };
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: { read: async () => "", write: async () => {}, stat: async () => undefined },
    plugin: { name: "starbridge-mod", root: "/m" },
    process: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    http: {
      fetch: async (url: string) => {
        if (url.endsWith("/ack")) acked = true;
        const events =
          url.includes("/events") && turn && !acked
            ? [{ type: "answer", ack: "k1", line, waiting: true }]
            : [];
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
  await handlers.get("session.start")?.($, { isInteractive: true }, async () => undefined);
  await handlers.get("turn.start")?.($, { text: "go", turnId: "t1" }, async () => undefined);
  turn = true;
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

test("an answer queued behind a typed prompt when the process exits comes back once on resume, and not after a hot reload (#1517)", async () => {
  const line = "Answer to d_1 (Build phase 1?): Build it";
  const files = new Map<string, string>();
  let acked = false;
  /** One Claude Code process on session s1; `state` is its `$.state`, kept across hot reloads. */
  const start = async (state: Map<string, unknown>) => {
    const { register } = (await import(REGISTER)) as {
      register: (on: (event: string, h: Handler) => void) => void;
    };
    const handlers = new Map<string, Handler>();
    register((event, h) => handlers.set(event, h));
    const submitted: string[] = [];
    const env: Record<string, string> = { STARBRIDGE_AGENT_SOCKET: "/sb/agent.sock", HOME: "/sb" };
    const $ = {
      env: { get: async (name: string) => env[name] },
      fs: {
        read: async (path: string) => {
          const text = files.get(path);
          if (text === undefined) throw new Error(`no ${path}`);
          return text;
        },
        write: async (path: string, text: string) => void files.set(path, text),
        exists: async (path: string) => files.has(path),
        stat: async () => undefined,
        list: async () => [],
      },
      state: {
        get: async (ref: { key: string }) => ({ value: state.get(ref.key), version: 0 }),
        set: async (ref: { key: string }, value: unknown) => void state.set(ref.key, value),
      },
      plugin: { name: "starbridge-mod", root: "/m" },
      process: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      http: {
        fetch: async (url: string) => {
          if (url.endsWith("/ack")) acked = true;
          const events =
            url.includes("/events") && !acked ? [{ type: "answer", ack: "d_1", line }] : [];
          return { status: 200, headers: {}, text: JSON.stringify({ events }) };
        },
      },
      ui: { log: () => {}, status: () => {} },
      clock: { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(Math.min(ms, 5)) },
      // Queued: it never starts in these processes.
      prompt: {
        submit: ({ text }: { text: string }) => {
          submitted.push(text);
          return new Promise(() => {});
        },
      },
      session: { id: async () => "s1", cwd: async () => "/work" },
    };
    const on = (event: string, e: object) => handlers.get(event)?.($, e, async () => ({}));
    await on("session.start", { isInteractive: true });
    return { submitted, on };
  };
  const until = async (ok: () => boolean) => {
    const by = Date.now() + 5000;
    while (!ok() && Date.now() < by) await Bun.sleep(10);
  };

  const first = await start(new Map());
  await until(() => acked);
  expect(first.submitted).toEqual([line]);
  // The owner's typed prompt runs ahead of the queued answer; then the process exits.
  await first.on("turn.start", { text: "i said build it, go ahead", turnId: "t1" });
  await first.on("turn.complete", { turnId: "t1" });

  const resumed = await start(new Map());
  await until(() => resumed.submitted.length > 0);
  await Bun.sleep(50);
  expect(resumed.submitted).toEqual([line]);

  // A hot reload of the resumed process keeps its queued prompt: nothing goes out again.
  const state = new Map<string, unknown>();
  const again = await start(state);
  await until(() => again.submitted.length > 0);
  const reloaded = await start(state);
  await Bun.sleep(100);
  expect(reloaded.submitted).toEqual([]);
  await reloaded.on("turn.start", {
    text: `The starbridge-mod plugin sent a message:\n${line}\n\nThis is how…`,
    turnId: "t2",
  });
  expect(JSON.parse(files.get("/sb/.config/starbridge/mod-sent/s1.json") ?? "")).toEqual([]);
  for (const p of [first, resumed, again, reloaded]) await p.on("session.end", { reason: "other" });
});

test("a subagent's question is tagged with its id, and its answer goes to it, even mid-turn (#1702)", async () => {
  const { register } = (await import(REGISTER)) as {
    register: (on: (event: string, h: Handler) => void) => void;
  };
  const handlers = new Map<string, Handler>();
  register((event, h) => handlers.set(event, h));
  const line = "Answer to d_1 (Which suffix?): beta";
  let acked = false;
  const sent: unknown[] = [];
  const submitted: string[] = [];
  const env: Record<string, string> = { STARBRIDGE_AGENT_SOCKET: "/sb/agent.sock", HOME: "/sb" };
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: { read: async () => "", write: async () => {}, stat: async () => undefined },
    plugin: { name: "starbridge-mod", root: "/m" },
    process: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    http: {
      fetch: async (url: string) => {
        if (url.endsWith("/ack")) acked = true;
        const events =
          url.includes("/events") && !acked
            ? [{ type: "answer", ack: "d_1", line, waiting: false, subagent: "a1" }]
            : [];
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
    session: {
      id: async () => "s1",
      cwd: async () => "/work",
      send: async (args: unknown) => {
        sent.push(args);
        return { isDelivered: true };
      },
    },
    tool: {
      check: async ({ input }: { input: { command: string } }) => ({
        decision: input.command.startsWith("starbridge ask") ? "allow" : "ask",
      }),
    },
  };

  // The subagent's `starbridge ask` runs with its id; the rules judge the command as written.
  let ran: { command?: string } = {};
  await handlers.get("tool.call")?.(
    $,
    { tool: "Bash", agentId: "a1", command: "starbridge ask --question Q" },
    async (e) => {
      ran = e as { command?: string };
      return { result: "ok" };
    },
  );
  expect(ran.command).toBe("export STARBRIDGE_CLAUDE_AGENT=a1\nstarbridge ask --question Q");
  const check = (command: string) =>
    handlers.get("tool.check")?.(
      $,
      { tool: "Bash", input: { command }, agentId: "a1" },
      async () => ({
        decision: "ask",
      }),
    ) as Promise<{ decision: string }>;
  expect((await check(ran.command as string)).decision).toBe("allow");
  expect((await check("export STARBRIDGE_CLAUDE_AGENT=a1\nrm -rf /")).decision).toBe("ask");

  await handlers.get("session.start")?.($, { isInteractive: true }, async () => undefined);
  // The main agent's turn runs: a subagent's answer does not wait for its next tool call.
  await handlers.get("turn.start")?.($, { text: "go", turnId: "t1" }, async () => undefined);
  const by = Date.now() + 5000;
  while (!acked && Date.now() < by) await Bun.sleep(20);
  expect(acked).toBe(true);
  expect(sent).toEqual([{ to: { agentId: "a1" }, text: line }]);
  expect(submitted).toEqual([]);
  await handlers.get("session.end")?.($, { reason: "other" }, async () => undefined);
});

test("an answer a subagent got after its last tool round goes to the parent once the subagent finishes (#1729)", async () => {
  const { register } = (await import(REGISTER)) as {
    register: (on: (event: string, h: Handler) => void) => void;
  };
  const handlers = new Map<string, Handler>();
  register((event, h) => handlers.set(event, h));
  const line = "Answer to d_1 (Which suffix?): beta";
  let acked = false;
  let status = "running";
  const files = new Map<string, string>();
  const sent: unknown[] = [];
  const submitted: string[] = [];
  const env: Record<string, string> = { STARBRIDGE_AGENT_SOCKET: "/sb/agent.sock", HOME: "/sb" };
  const state = new Map<string, string>();
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path) ?? "",
      write: async (path: string, text: string) => void files.set(path, text),
      stat: async () => undefined,
      list: async () => [],
    },
    state: {
      get: async ({ key }: { key: string }) => ({ value: state.get(key) }),
      set: async ({ key }: { key: string }, value: string) => void state.set(key, value),
    },
    agent: { list: async () => [{ id: "a1", status }] },
    plugin: { name: "starbridge-mod", root: "/m" },
    process: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    http: {
      fetch: async (url: string) => {
        if (url.endsWith("/ack")) acked = true;
        const events =
          url.includes("/events") && !acked
            ? [{ type: "answer", ack: "d_1", line, waiting: false, subagent: "a1" }]
            : [];
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
    session: {
      id: async () => "s1",
      cwd: async () => "/work",
      send: async (args: unknown) => {
        sent.push(args);
        return { isDelivered: true };
      },
    },
    tool: { check: async () => ({ decision: "allow" }) },
  };

  // The subagent's last tool round asks; the answer comes while its final reply is written.
  await handlers.get("tool.call")?.(
    $,
    { tool: "Bash", agentId: "a1", command: "starbridge ask --question Q" },
    async (e) => ({ ...(e as object), result: "ok" }),
  );
  await Bun.sleep(5);
  await handlers.get("session.start")?.($, { isInteractive: true }, async () => undefined);
  const by = Date.now() + 5000;
  while (!acked && Date.now() < by) await Bun.sleep(20);
  expect(sent).toEqual([{ to: { agentId: "a1" }, text: line }]);

  // A subagent that runs on reads it at its next round: its turn's end hands nothing over.
  await handlers.get("turn.complete")?.($, { turnId: "t1", agentId: "a1" }, async () => undefined);
  await Bun.sleep(50);
  expect(submitted).toEqual([]);

  // It finished without another round: the parent gets the answer, once.
  status = "completed";
  await handlers.get("turn.complete")?.($, { turnId: "t2", agentId: "a1" }, async () => undefined);
  const until = Date.now() + 5000;
  while (submitted.length === 0 && Date.now() < until) await Bun.sleep(20);
  expect(submitted).toEqual([
    `${line}\nYour subagent a1 asked this and could not take the answer: act on it, or pass it on.`,
  ]);
  await handlers.get("session.end")?.($, { reason: "other" }, async () => undefined);
});
