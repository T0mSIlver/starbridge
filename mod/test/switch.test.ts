import { expect, test } from "bun:test";
import { joinLines } from "../hooks/agent.ts";
import { type Host, Poller, type Timing } from "../hooks/poller.ts";
import { ownArgs, Switch, wantsLoop } from "../hooks/switch.ts";

test("a session a host keeps open gets the loop; a run that ends with its turn does not (#863)", () => {
  expect(wantsLoop(true, undefined)).toBe(true);
  // Claude desktop's Code tab and IDEs run Claude Code through the SDK: not interactive to the engine.
  expect(wantsLoop(false, "claude-desktop")).toBe(true);
  expect(wantsLoop(false, "claude-vscode")).toBe(true);
  for (const oneShot of ["sdk-cli", "sdk-ts", "sdk-py", undefined])
    expect(wantsLoop(false, oneShot)).toBe(false);
});

test("T3 Code's SDK sessions get the loop, by T3's tools in Claude Code's arguments (#2100)", () => {
  // As T3 Code 0.1.1 starts Claude Code, cut down.
  const t3 =
    "/usr/bin/claude --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --allowedTools mcp__t3-code__* --tools default --session-id=5d5fb086";
  expect(wantsLoop(false, "sdk-ts", t3)).toBe(true);
  // A read-only T3 session allows its read-only tools by name.
  expect(
    wantsLoop(false, "sdk-ts", "claude --allowedTools Read,mcp__t3-code__t3_thread_list"),
  ).toBe(true);
  // A script's session, even one that names another server's tools, ends with its last turn.
  const script =
    "claude --output-format stream-json --input-format stream-json --allowedTools mcp__other__x";
  expect(wantsLoop(false, "sdk-ts", script)).toBe(false);
  expect(wantsLoop(false, "sdk-ts", undefined)).toBe(false);
  // `claude -p` never, whatever it allows.
  expect(wantsLoop(false, "sdk-cli", t3)).toBe(false);
  expect(wantsLoop(false, undefined, t3)).toBe(false);
});

test("ownArgs reads the Claude Code process's command line, and gives up on a failed read", async () => {
  expect(await ownArgs(async () => ({ exitCode: 0, stdout: "claude --verbose \n" }))).toBe(
    "claude --verbose \n",
  );
  expect(await ownArgs(async () => ({ exitCode: 1, stdout: "" }))).toBeUndefined();
  expect(
    await ownArgs(async () => {
      throw new Error("no sh");
    }),
  ).toBeUndefined();
  // The real thing on this machine: the parent of the shell is this test's process.
  if (process.platform !== "win32") {
    const real = await ownArgs(async (argv) => {
      const p = Bun.spawnSync(argv);
      return { exitCode: p.exitCode ?? 1, stdout: p.stdout.toString() };
    });
    expect(real).toContain("bun");
  }
});

const FAST: Timing = {
  waitSeconds: 1,
  checkMs: 10,
  recheckMs: 60_000,
  leaseMs: 2_000,
  minCycleMs: 20,
  backoffMs: 20,
  maxBackoffMs: 160,
};

test("a loop that replaces another mid-confirm does not submit its answer again (#1337)", async () => {
  const files = new Map<string, string>();
  const submitted: string[] = [];
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let acked = false;
  const host: Host = {
    sessionId: async () => "s1",
    // The CLI hands over one answer until it is confirmed; the first confirm takes a while.
    run: async (argv) => {
      if (argv.includes("--ack")) {
        await held;
        acked = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const line = JSON.stringify({ decisionId: "d1", ack: "d1", line: "Answer to d1: Merge" });
      return { exitCode: 0, stdout: acked ? "" : `${line}\n`, stderr: "" };
    },
    read: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    write: async (path, text) => {
      files.set(path, text);
    },
    mtime: async () => undefined,
    owned: async () => false,
    now: async () => Date.now(),
    sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
    submit: (lines) => {
      submitted.push(joinLines(lines));
      return lines.map((l) => l.ack);
    },
    starting: () => false,
    status: () => {},
    log: () => {},
  };
  const loop = (unconfirmed?: Set<string>) =>
    new Switch(
      {
        agentUp: async () => false,
        agent: () => {
          throw new Error("no agent");
        },
        poller: (u) => new Poller(host, "/sb", "starbridge", FAST, u),
        sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
        clearStatus: () => {},
        log: () => {},
      },
      30_000,
      unconfirmed,
    );
  const first = loop();
  const by = Date.now() + 5000;
  while (submitted.length === 0 && Date.now() < by) await Bun.sleep(10);
  // A hot reload: the mod's `session.start` replaces the loop while it confirms.
  void first.stop();
  const second = loop(first.unconfirmed);
  await Bun.sleep(300);
  release();
  await Bun.sleep(100);
  await second.stop();
  expect(submitted).toEqual(["Answer to d1: Merge"]);
});

test("a host that throws once its session is gone does not reject the loop (#1365)", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    // Pi's `ctx` after the session was replaced or reloaded.
    let replaced = false;
    const live = <T>(value: T) => {
      if (replaced) throw new Error("This extension ctx is stale after session replacement");
      return value;
    };
    const host: Host = {
      sessionId: async () => live("s1"),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      read: async () => {
        throw new Error("ENOENT");
      },
      write: async () => {},
      mtime: async () => undefined,
      owned: async () => false,
      now: async () => Date.now(),
      sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
      submit: () => live([]),
      starting: () => false,
      status: () => live(undefined),
      log: () => {},
    };
    const loop = new Switch(
      {
        agentUp: async () => false,
        agent: () => {
          throw new Error("no agent");
        },
        poller: (u) => new Poller(host, "/sb", "starbridge", FAST, u),
        sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
        clearStatus: () => live(undefined),
        log: () => {},
      },
      50,
    );
    await Bun.sleep(30);
    expect(loop.mode).toBe("cli");
    // Pi's `session_shutdown`, then the new session's start makes the old `ctx` throw; the loop
    // wakes from its probe after that and stops the poller, which reads the session id.
    await loop.stop();
    replaced = true;
    await loop.done;
    await Bun.sleep(100);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
