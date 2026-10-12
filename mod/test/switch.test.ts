import { expect, test } from "bun:test";
import { type Host, Poller, type Timing } from "../hooks/poller.ts";
import { Switch, wantsLoop } from "../hooks/switch.ts";

test("a session a host keeps open gets the loop; a run that ends with its turn does not (#863)", () => {
  expect(wantsLoop(true, undefined)).toBe(true);
  // Claude desktop's Code tab and IDEs run Claude Code through the SDK: not interactive to the engine.
  expect(wantsLoop(false, "claude-desktop")).toBe(true);
  expect(wantsLoop(false, "claude-vscode")).toBe(true);
  for (const oneShot of ["sdk-cli", "sdk-ts", "sdk-py", undefined])
    expect(wantsLoop(false, oneShot)).toBe(false);
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
    now: async () => Date.now(),
    sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
    submit: (text) => {
      submitted.push(text);
    },
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
      now: async () => Date.now(),
      sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
      submit: () => live(undefined),
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
