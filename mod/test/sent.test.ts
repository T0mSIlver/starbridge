import { expect, test } from "bun:test";
import { Sent, type SentHost } from "../hooks/sent.ts";

const LINE = "Answer to d_1 (Build phase 1?): Build it";
const framed = (line: string) =>
  `The starbridge-mod plugin sent a message:\n${line}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns.`;

/** One machine's files, shared by the processes a test starts on it. */
function machine() {
  const files = new Map<string, string>();
  const disk = { full: false, slow: Promise.resolve() as Promise<unknown> };
  return {
    files,
    disk,
    /** A process on session `session`: its prompts resolve when the test starts their turn. */
    process(session: string | (() => string), token: string | undefined) {
      const submitted: string[] = [];
      const pending: { text: string; settle: (r: unknown) => void; fail: (e: Error) => void }[] =
        [];
      const host: SentHost = {
        sessionId: async () => (typeof session === "string" ? session : session()),
        read: async (path) => {
          const text = files.get(path);
          if (text === undefined) throw new Error(`no ${path}`);
          return text;
        },
        write: async (path, text) => {
          await disk.slow;
          if (disk.full) throw new Error("disk full");
          files.set(path, text);
        },
        now: async () => Date.now(),
        submit: (text) => {
          submitted.push(text);
          return new Promise((settle, fail) => pending.push({ text, settle, fail }));
        },
        log: () => {},
      };
      const sent = new Sent(host, "/sb", token);
      const take = (text: string) => {
        const i = pending.findIndex((p) => p.text === text);
        return i < 0 ? undefined : pending.splice(i, 1)[0];
      };
      return {
        sent,
        submitted,
        /** The prompt's turn starts: `turn.start` carries it, then its submit resolves. */
        async start(text: string) {
          await sent.started(framed(text));
          take(text)?.settle({ text });
        },
        refuse(text: string) {
          take(text)?.settle({ drop: "no" });
        },
      };
    },
  };
}

const lines = (m: ReturnType<typeof machine>, session = "s1") =>
  JSON.parse(m.files.get(`/sb/mod-sent/${session}.json`) ?? "[]") as { ack: string }[];

test("a queued answer that a typed prompt ran ahead of stays on record until its own turn starts (#1517)", async () => {
  const m = machine();
  const p = m.process("s1", "proc-1");
  expect(await p.sent.send(LINE, "d_1")).toBe(true);
  expect(p.submitted).toEqual([LINE]);
  // The owner's typed prompt dequeues first; its turn carries no answer.
  await p.sent.started("i said build it, go ahead");
  expect(lines(m).map((l) => l.ack)).toEqual(["d_1"]);
  // Its turn ends: the answer is still queued in this process, so nothing goes out again.
  await p.sent.recover();
  expect(p.submitted).toEqual([LINE]);
  await p.start(LINE);
  expect(lines(m)).toEqual([]);
});

test("a process that exits with an answer still queued: the next one on that session submits it, once (#1517)", async () => {
  const m = machine();
  const first = m.process("s1", "proc-1");
  await first.sent.send(LINE, "d_1");
  // The process exits before the prompt's turn; `--resume` starts another on the same session.
  const second = m.process("s1", "proc-2");
  await second.sent.recover();
  expect(second.submitted).toEqual([LINE]);
  // The loop hands the line over again if the first process never confirmed it: no second copy.
  expect(await second.sent.send(LINE, "d_1")).toBe(true);
  await second.sent.recover();
  expect(second.submitted).toEqual([LINE]);
  await second.start(LINE);
  expect(lines(m)).toEqual([]);
  // A third process finds nothing left.
  const third = m.process("s1", "proc-3");
  await third.sent.recover();
  expect(third.submitted).toEqual([]);
});

test("after a hot reload the queued prompt is still there: the reloaded mod submits nothing again (#1517)", async () => {
  const m = machine();
  const before = m.process("s1", "proc-1");
  await before.sent.send(LINE, "d_1");
  // `$.state` keeps the process's token across the reload.
  const after = m.process("s1", "proc-1");
  await after.sent.recover();
  expect(await after.sent.send(LINE, "d_1")).toBe(true);
  expect(after.submitted).toEqual([]);
  // Only the new module's `turn.start` sees the turn.
  await after.sent.started(framed(LINE));
  expect(lines(m)).toEqual([]);
});

test("without `$.state` no answer goes out again: a reload could not be told from a new process", async () => {
  const m = machine();
  await m.process("s1", undefined).sent.send(LINE, "d_1");
  const next = m.process("s1", undefined);
  await next.sent.recover();
  expect(await next.sent.send(LINE, "d_1")).toBe(true);
  expect(next.submitted).toEqual([]);
});

test("a refused submit goes out again at the next recover, up to three submits in all", async () => {
  const m = machine();
  const p = m.process("s1", "proc-1");
  await p.sent.send(LINE, "d_1");
  for (let i = 0; i < 3; i++) {
    p.refuse(LINE);
    await Bun.sleep(5);
    await p.sent.recover();
  }
  expect(p.submitted).toEqual([LINE, LINE, LINE]);
  expect(lines(m)).toEqual([]);
});

test("another session's lines stay where they are", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send(LINE, "d_1");
  const other = m.process("s2", "proc-2");
  await other.sent.recover();
  expect(other.submitted).toEqual([]);
  expect(lines(m).map((l) => l.ack)).toEqual(["d_1"]);
});

test("a line that cannot be recorded is not submitted, so the loop tries it again", async () => {
  const m = machine();
  const p = m.process("s1", "proc-1");
  m.disk.full = true;
  expect(await p.sent.send(LINE, "d_1")).toBe(false);
  expect(p.submitted).toEqual([]);
  m.disk.full = false;
  expect(await p.sent.send(LINE, "d_1")).toBe(true);
  expect(p.submitted).toEqual([LINE]);
});

test("the loop and the recovery picking up a dead process's line at once submit it once", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send(LINE, "d_1");
  const next = m.process("s1", "proc-2");
  await Promise.all([next.sent.recover(), next.sent.send(LINE, "d_1")]);
  expect(next.submitted).toEqual([LINE]);
});

test("a /clear while the line is recorded: nothing goes into the new session, and the old one gets it back", async () => {
  const m = machine();
  let current = "s1";
  const p = m.process(() => current, "proc-1");
  let release = () => {};
  m.disk.slow = new Promise((r) => {
    release = () => r(undefined);
  });
  const sending = p.sent.send(LINE, "d_1");
  await Bun.sleep(5);
  current = "s2";
  release();
  expect(await sending).toBe(false);
  expect(p.submitted).toEqual([]);
  current = "s1";
  await p.sent.recover();
  expect(p.submitted).toEqual([LINE]);
});

test("an answer queued in each of several processes that exit is still submitted by the next", async () => {
  const m = machine();
  await m.process("s1", "proc-0").sent.send(LINE, "d_1");
  for (let i = 1; i <= 4; i++) {
    const p = m.process("s1", `proc-${i}`);
    await p.sent.recover();
    expect(p.submitted).toEqual([LINE]);
  }
});
