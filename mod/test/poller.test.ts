import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { LiveServer } from "@starbridge/server/test-support";
import { run } from "../../cli/src/cli";
import { paired, type TestCtx, until } from "../../cli/test/helpers";
import { type Host, Poller, type Timing } from "../hooks/poller.ts";

const FAST: Timing = {
  waitSeconds: 1,
  checkMs: 10,
  leaseMs: 2_000,
  minCycleMs: 20,
  backoffMs: 20,
  maxBackoffMs: 160,
};

let server: LiveServer;
let cli: TestCtx;
const pollers: Poller[] = [];
beforeEach(async () => {
  server = await LiveServer.start();
  cli = await paired(server);
});
afterEach(async () => {
  await Promise.all(pollers.splice(0).map((p) => p.stop()));
  server.stop();
});

/** A session with the mod: the engine's `$` reduced to what the poller uses, the CLI in-process. */
function session(id: string) {
  const s = {
    id,
    submitted: [] as string[],
    runs: [] as string[][],
    status: undefined as string | undefined,
    logs: [] as string[],
    /** Called when a CLI run returns, before the poller sees its output. */
    afterRun: undefined as ((stdout: string) => void) | undefined,
  };
  const host: Host = {
    sessionId: async () => s.id,
    run: async (argv) => {
      s.runs.push(argv);
      const out: string[] = [];
      const err: string[] = [];
      const exitCode = await run(argv.slice(1), {
        ...cli,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      });
      const stdout = out.map((l) => `${l}\n`).join("");
      s.afterRun?.(stdout);
      return { exitCode, stdout, stderr: err.join("\n") };
    },
    read: async (path) => readFileSync(path, "utf8"),
    write: async (path, text) => writeFileSync(path, text),
    mtime: async (path) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return undefined;
      }
    },
    now: async () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    submit: (text) => s.submitted.push(text),
    status: (text) => {
      s.status = text;
    },
    log: (text) => s.logs.push(text),
  };
  const poller = new Poller(host, cli.store.dir, "starbridge", FAST);
  pollers.push(poller);
  return { get: () => s, poller };
}

async function ask(question: string, sessionId?: string): Promise<string> {
  const args = [
    "ask",
    "--question",
    question,
    "--option",
    "Yes",
    "--option",
    "No",
    "--default",
    "Yes",
  ];
  expect(await run([...args, ...(sessionId ? ["--session", sessionId] : [])], cli)).toBe(0);
  return cli.lines.at(-1) as string;
}

const polling = (s: ReturnType<typeof session>) =>
  s.get().runs.filter((a) => a.includes("--wait")).length;

test("each answer reaches the session that asked, once, through one poller", async () => {
  const a = session("s-a");
  const b = session("s-b");
  const c = session("s-c");
  const da = await ask("Merge #12 now?", "s-a");
  const db = await ask("Deploy tonight?", "s-b");
  const nobody = await ask("Asked outside Claude Code?");
  await until(() => polling(a) + polling(b) + polling(c) > 0);

  await server.answer(db, { choice: "No" });
  await server.answer(da, { choice: "Yes" });
  await server.answer(nobody, { choice: "Yes" });
  await until(() => a.get().submitted.length + b.get().submitted.length === 2);
  await Bun.sleep(100);

  expect(a.get().submitted).toEqual([`Answer to ${da} (Merge #12 now?): Yes`]);
  expect(b.get().submitted).toEqual([`Answer to ${db} (Deploy tonight?): No`]);
  expect(c.get().submitted).toEqual([]);
  // One session holds the lease and polls; the others only read the state file.
  expect([polling(a), polling(b), polling(c)].filter((n) => n > 0)).toHaveLength(1);
  // The others ran the CLI only when the state file changed: the asks, the stored answers.
  const local = [a, b, c].map((s) => s.get().runs.length - polling(s));
  expect(Math.max(...local)).toBeLessThanOrEqual(6);
});

test("a forged answer is never submitted", async () => {
  const a = session("s-a");
  const da = await ask("Merge #12 now?", "s-a");
  await until(() => polling(a) > 0);
  // The real server takes one answer per decision; these two need a compromised one.
  await server.forge(
    { decisionId: da, reply: { choice: "Ship it" } },
    { decisionId: da, reply: { choice: "Yes" }, tamper: { decisionId: "d_forged" } },
  );
  await until(() => server.log.filter((l) => l === "GET /answers").length >= 3);
  expect(a.get().submitted).toEqual([]);
  expect(a.get().logs.filter((l) => l.includes("ignored an answer"))).toHaveLength(2);
});

test("another session takes over polling when the poller stops", async () => {
  const a = session("s-a");
  await until(() => polling(a) > 0);
  const b = session("s-b");
  await Bun.sleep(50);
  expect(polling(b)).toBe(0);
  await a.poller.stop();
  const db = await ask("Deploy tonight?", "s-b");
  await until(() => polling(b) > 0);
  await server.answer(db, { choice: "Yes" });
  await until(() => b.get().submitted.length === 1);
});

test("backs off while the server fails, then recovers", async () => {
  const a = session("s-a");
  const da = await ask("Merge #12 now?", "s-a");
  await until(() => polling(a) > 0);
  server.failures.push(...Array(50).fill("/answers"));
  await until(() => a.get().status !== undefined);
  expect(a.get().status).toContain("503");
  const before = polling(a);
  await Bun.sleep(600);
  // 20, 40, 80, 160, 160 ms: a handful of tries, not a spin.
  expect(polling(a) - before).toBeLessThanOrEqual(6);
  server.failures.length = 0;
  await server.answer(da, { choice: "No" });
  await until(() => a.get().submitted.length === 1, 3000);
  expect(a.get().status).toBeUndefined();
});

test("backs off when the CLI is missing or unpaired", async () => {
  const a = session("s-a");
  writeFileSync(`${cli.store.dir}/machine.json`, "");
  await until(() => a.get().runs.length >= 2);
  await Bun.sleep(300);
  expect(a.get().runs.length).toBeLessThanOrEqual(5);
  expect(a.get().logs[0]).toContain("retrying");
  expect(JSON.parse(readFileSync(`${cli.store.dir}/mod-poller.json`, "utf8")).session).toBe("s-a");
});

test("the poller keeps its lease across a /clear, under the new session id", async () => {
  const a = session("s-a");
  const b = session("s-b");
  await until(() => polling(a) + polling(b) > 0);
  const leader = polling(a) > 0 ? a : b;
  leader.get().id = "s-cleared";
  const d = await ask("Asked after the clear?", "s-cleared");
  await server.answer(d, { choice: "Yes" });
  // Well within the lease, which still names the old id.
  await until(() => leader.get().submitted.length === 1, 1500);
  const lease = JSON.parse(readFileSync(`${cli.store.dir}/mod-poller.json`, "utf8"));
  expect(lease.session).toBe("s-cleared");
});

test("an answer in flight during a /clear waits for its own session", async () => {
  const a = session("s-a");
  const da = await ask("Merge #12 now?", "s-a");
  await until(() => polling(a) > 0);
  // The /clear lands while the poll that carries the answer is running.
  a.get().afterRun = (stdout) => {
    if (stdout.includes(da)) a.get().id = "s-new";
  };
  await server.answer(da, { choice: "Yes" });
  await until(() => a.get().id === "s-new");
  await Bun.sleep(200);
  expect(a.get().submitted).toEqual([]);
  expect(a.get().logs.some((l) => l.includes(da))).toBe(true);

  // Resuming the old session hands it over there, once.
  a.get().afterRun = undefined;
  a.get().id = "s-a";
  await until(() => a.get().submitted.length === 1);
  await Bun.sleep(200);
  expect(a.get().submitted).toEqual([`Answer to ${da} (Merge #12 now?): Yes`]);
});
