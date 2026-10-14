import { expect, test } from "bun:test";
import { Sent, type SentHost, sessionElsewhere } from "../hooks/sent.ts";

const LINE = "Answer to d_1 (Build phase 1?): Build it";
const framed = (line: string) =>
  `The starbridge-mod plugin sent a message:\n${line}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns.`;

/** One machine's files, shared by the processes a test starts on it. */
function machine() {
  const files = new Map<string, string>();
  /** Sessions another live process runs too. */
  const live = new Set<string>();
  const disk = { full: false, unreadable: false, slow: Promise.resolve() as Promise<unknown> };
  /** Runs while a process checks for another live one on its session, before the answer. */
  const checking = { run: async () => {} };
  return {
    files,
    disk,
    live,
    checking,
    /** A process on session `session`: its prompts resolve when the test starts their turn. */
    process(session: string | (() => string), token: string | undefined) {
      const submitted: string[] = [];
      const pending: { text: string; settle: (r: unknown) => void; fail: (e: Error) => void }[] =
        [];
      const host: SentHost = {
        sessionId: async () => (typeof session === "string" ? session : session()),
        read: async (path) => {
          if (disk.unreadable) throw new Error("EIO");
          return files.get(path);
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
        elsewhere: async (s) => {
          await checking.run();
          return live.has(s);
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
  expect(await p.sent.send([{ text: LINE, ack: "d_1" }])).toEqual(["d_1"]);
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
  await first.sent.send([{ text: LINE, ack: "d_1" }]);
  // The process exits before the prompt's turn; `--resume` starts another on the same session.
  const second = m.process("s1", "proc-2");
  await second.sent.recover();
  expect(second.submitted).toEqual([LINE]);
  // The loop hands the line over again if the first process never confirmed it: no second copy.
  expect(await second.sent.send([{ text: LINE, ack: "d_1" }])).toEqual(["d_1"]);
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
  await before.sent.send([{ text: LINE, ack: "d_1" }]);
  // `$.state` keeps the process's token across the reload.
  const after = m.process("s1", "proc-1");
  await after.sent.recover();
  expect(await after.sent.send([{ text: LINE, ack: "d_1" }])).toEqual(["d_1"]);
  expect(after.submitted).toEqual([]);
  // Only the new module's `turn.start` sees the turn.
  await after.sent.started(framed(LINE));
  expect(lines(m)).toEqual([]);
});

test("without `$.state` no answer goes out again: a reload could not be told from a new process", async () => {
  const m = machine();
  await m.process("s1", undefined).sent.send([{ text: LINE, ack: "d_1" }]);
  const next = m.process("s1", undefined);
  await next.sent.recover();
  expect(await next.sent.send([{ text: LINE, ack: "d_1" }])).toEqual(["d_1"]);
  expect(next.submitted).toEqual([]);
});

test("a refused submit goes out again at the next recover, up to three submits in all", async () => {
  const m = machine();
  const p = m.process("s1", "proc-1");
  await p.sent.send([{ text: LINE, ack: "d_1" }]);
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
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  const other = m.process("s2", "proc-2");
  await other.sent.recover();
  expect(other.submitted).toEqual([]);
  expect(lines(m).map((l) => l.ack)).toEqual(["d_1"]);
});

test("a line that cannot be recorded is not submitted, so the loop tries it again", async () => {
  const m = machine();
  const p = m.process("s1", "proc-1");
  m.disk.full = true;
  expect(await p.sent.send([{ text: LINE, ack: "d_1" }])).toEqual([]);
  expect(p.submitted).toEqual([]);
  m.disk.full = false;
  expect(await p.sent.send([{ text: LINE, ack: "d_1" }])).toEqual(["d_1"]);
  expect(p.submitted).toEqual([LINE]);
});

test("the loop and the recovery picking up a dead process's line at once submit it once", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  const next = m.process("s1", "proc-2");
  await Promise.all([next.sent.recover(), next.sent.send([{ text: LINE, ack: "d_1" }])]);
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
  const sending = p.sent.send([{ text: LINE, ack: "d_1" }]);
  await Bun.sleep(5);
  current = "s2";
  release();
  expect(await sending).toEqual([]);
  expect(p.submitted).toEqual([]);
  current = "s1";
  await p.sent.recover();
  expect(p.submitted).toEqual([LINE]);
});

test("an answer queued in each of several processes that exit is still submitted by the next", async () => {
  const m = machine();
  await m.process("s1", "proc-0").sent.send([{ text: LINE, ack: "d_1" }]);
  for (let i = 1; i <= 4; i++) {
    const p = m.process("s1", `proc-${i}`);
    await p.sent.recover();
    expect(p.submitted).toEqual([LINE]);
  }
});

test("a second live process on the session leaves the first one's queued answer alone", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  m.live.add("s1");
  const second = m.process("s1", "proc-2");
  await second.sent.recover();
  expect(await second.sent.send([{ text: LINE, ack: "d_1" }])).toEqual(["d_1"]);
  expect(second.submitted).toEqual([]);
});

test("another process runs the session when a live pid other than ours names it", async () => {
  const files: Record<string, string> = {
    "/c/sessions/10.json": JSON.stringify({ pid: 10, sessionId: "s1" }),
    "/c/sessions/11.json": JSON.stringify({ pid: 11, sessionId: "s1" }),
    "/c/sessions/12.json": JSON.stringify({ pid: 12, sessionId: "s2" }),
  };
  const fs = {
    list: async () => Object.keys(files).map((p) => ({ name: p.slice("/c/sessions/".length) })),
    read: async (p: string) => files[p] as string,
  };
  const live = (pids: number[]) => async (pid: number) => pids.includes(pid);
  expect(await sessionElsewhere("s1", 10, fs, "/c/sessions", live([10, 11, 12]))).toBe(true);
  // A file left by a process that ended.
  expect(await sessionElsewhere("s1", 10, fs, "/c/sessions", live([10, 12]))).toBe(false);
  expect(await sessionElsewhere("s2", 12, fs, "/c/sessions", live([10, 11, 12]))).toBe(false);
});

test("once the other live process on the session exits, the next turn's end submits its answer", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  m.live.add("s1");
  const second = m.process("s1", "proc-2");
  await second.sent.recover();
  expect(second.submitted).toEqual([]);
  m.live.delete("s1");
  await second.sent.recover();
  expect(second.submitted).toEqual([LINE]);
  await second.sent.recover();
  expect(second.submitted).toEqual([LINE]);
});

test("a /clear while recover records its lines leaves them for the old session", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  let current = "s1";
  const p = m.process(() => current, "proc-2");
  let release = () => {};
  m.disk.slow = new Promise((r) => {
    release = () => r(undefined);
  });
  const recovering = p.sent.recover();
  await Bun.sleep(5);
  current = "s2";
  release();
  await recovering;
  expect(p.submitted).toEqual([]);
  current = "s1";
  await p.sent.recover();
  expect(p.submitted).toEqual([LINE]);
});

test("an answer the other live process ran before it exited is not submitted again (#1559)", async () => {
  const m = machine();
  const first = m.process("s1", "proc-1");
  await first.sent.send([{ text: LINE, ack: "d_1" }]);
  m.live.add("s1");
  const second = m.process("s1", "proc-2");
  await second.sent.recover();
  expect(second.submitted).toEqual([]);
  // The first process runs the answer's turn, then exits.
  await first.start(LINE);
  m.live.delete("s1");
  await second.sent.recover();
  expect(second.submitted).toEqual([]);
});

test("an answer the other process runs while this one checks for it is not submitted again (#1559)", async () => {
  const m = machine();
  const first = m.process("s1", "proc-1");
  await first.sent.send([{ text: LINE, ack: "d_1" }]);
  const second = m.process("s1", "proc-2");
  // Between this process reading the file and finding no other process, the first one runs the
  // answer's turn and exits.
  m.checking.run = async () => {
    m.checking.run = async () => {};
    await first.start(LINE);
  };
  await second.sent.recover();
  expect(second.submitted).toEqual([]);
});

test("a line handed over again after the other process ran it and exited is not submitted again (#1559)", async () => {
  const m = machine();
  const first = m.process("s1", "proc-1");
  await first.sent.send([{ text: LINE, ack: "d_1" }]);
  const second = m.process("s1", "proc-2");
  m.checking.run = async () => {
    m.checking.run = async () => {};
    await first.start(LINE);
  };
  expect(await second.sent.send([{ text: LINE, ack: "d_1" }])).toEqual(["d_1"]);
  expect(second.submitted).toEqual([]);
});

test("a process that starts while this one checks for a live one keeps its own answer (#1559)", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  const second = m.process("s1", "proc-2");
  const third = m.process("s1", "proc-3");
  const other = "Answer to d_2 (Ship?): Ship";
  // The first process has exited; the third starts and records its answer before its record of
  // the session is listed.
  m.checking.run = async () => {
    m.checking.run = async () => {};
    await third.sent.send([{ text: other, ack: "d_2" }]);
  };
  await second.sent.recover();
  expect(second.submitted).toEqual([LINE]);
  expect(third.submitted).toEqual([other]);
});

test("a line handed over while a new process takes it stays with that process (#1559)", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  const second = m.process("s1", "proc-2");
  const third = m.process("s1", "proc-3");
  m.checking.run = async () => {
    m.checking.run = async () => {};
    await third.sent.recover();
  };
  expect(await second.sent.send([{ text: LINE, ack: "d_1" }])).toEqual(["d_1"]);
  expect(second.submitted).toEqual([]);
  expect(third.submitted).toEqual([LINE]);
});

test("a file that cannot be read is left as it is, and the line is tried again (#1559)", async () => {
  const m = machine();
  const p = m.process("s1", "proc-1");
  await p.sent.send([{ text: LINE, ack: "d_1" }]);
  m.disk.unreadable = true;
  const other = "Answer to d_2 (Ship?): Ship";
  expect(await p.sent.send([{ text: other, ack: "d_2" }])).toEqual([]);
  await p.sent.recover().catch(() => undefined);
  m.disk.unreadable = false;
  expect(lines(m).map((l) => l.ack)).toEqual(["d_1"]);
  expect(await p.sent.send([{ text: other, ack: "d_2" }])).toEqual(["d_2"]);
  expect(lines(m).map((l) => l.ack)).toEqual(["d_1", "d_2"]);
});

test("a recovery whose write fails submits the answer at the next try (#1559)", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  const next = m.process("s1", "proc-2");
  m.disk.full = true;
  await next.sent.recover().catch(() => undefined);
  expect(next.submitted).toEqual([]);
  m.disk.full = false;
  await next.sent.recover();
  expect(next.submitted).toEqual([LINE]);
});

test("a session record with bytes left after its object still names its process (#1559)", async () => {
  // Claude Code rewrites the file in place, so a shorter record leaves the old one's tail.
  const files: Record<string, string> = {
    "/c/sessions/11.json": `${JSON.stringify({ pid: 11, sessionId: "s1" })}0,"name":"x"}`,
  };
  const fs = {
    list: async () => Object.keys(files).map((p) => ({ name: p.slice("/c/sessions/".length) })),
    read: async (p: string) => files[p] as string,
  };
  expect(await sessionElsewhere("s1", 10, fs, "/c/sessions", async () => true)).toBe(true);
});

test("answers pending at once go as one prompt, one line each in their order, and leave together (#1597)", async () => {
  const m = machine();
  const p = m.process("s1", "proc-1");
  const two = "Answer to d_2 (Ship it?): Ship";
  expect(
    await p.sent.send([
      { text: LINE, ack: "d_1" },
      { text: two, ack: "d_2" },
    ]),
  ).toEqual(["d_1", "d_2"]);
  expect(p.submitted).toEqual([`${LINE}\n${two}`]);
  expect(lines(m).map((l) => l.ack)).toEqual(["d_1", "d_2"]);
  await p.start(`${LINE}\n${two}`);
  expect(lines(m)).toEqual([]);
});

test("a process that exits with several answers queued: the next one submits them as one prompt (#1597)", async () => {
  const m = machine();
  const two = "Answer to d_2 (Ship it?): Ship";
  await m.process("s1", "proc-1").sent.send([
    { text: LINE, ack: "d_1" },
    { text: two, ack: "d_2" },
  ]);
  const next = m.process("s1", "proc-2");
  await next.sent.recover();
  expect(next.submitted).toEqual([`${LINE}\n${two}`]);
});

test("a batch that cannot be recorded still confirms the line another live process has out (#1597)", async () => {
  const m = machine();
  await m.process("s1", "proc-1").sent.send([{ text: LINE, ack: "d_1" }]);
  m.live.add("s1");
  m.disk.full = true;
  const second = m.process("s1", "proc-2");
  const two = "Answer to d_2 (Ship it?): Ship";
  // d_1 is queued in the other process: confirmed here, never submitted again; d_2 waits.
  expect(
    await second.sent.send([
      { text: LINE, ack: "d_1" },
      { text: two, ack: "d_2" },
    ]),
  ).toEqual(["d_1"]);
  expect(second.submitted).toEqual([]);
});

test("an answer sent to a subagent stays on record until it reads it; a process that exits first leaves it to the parent (#1702)", async () => {
  const m = machine();
  const a = m.process("s1", "proc-a");
  const note = `${LINE}\nYour subagent a1 asked this and could not take the answer: act on it, or pass it on.`;
  const batch = [{ text: note, ack: "d_1" }];
  // A send that fails leaves nothing behind.
  expect(
    (await a.sent.toAgent("a1", batch, async () => ({ isDelivered: false }))).isDelivered,
  ).toBe(false);
  expect(lines(m)).toEqual([]);
  await a.sent.toAgent("a1", batch, async () => ({ isDelivered: true }));
  expect(lines(m).map((l) => l.ack)).toEqual(["d_1"]);
  // The same process's turn ends: the subagent may still read it, so nothing goes out again.
  await a.sent.recover();
  expect(a.submitted).toEqual([]);

  // The process exits before the subagent's next round: the next one on the session hands the
  // answer to the parent.
  const b = m.process("s1", "proc-b");
  await b.sent.recover();
  expect(b.submitted).toEqual([note]);

  // Read before the process exits: the record goes.
  const c = m.process("s2", "proc-c");
  await c.sent.toAgent("a2", [{ text: note, ack: "d_2" }], async () => ({ isDelivered: true }));
  await c.sent.read("a2", Date.now());
  expect(lines(m, "s2")).toEqual([]);
});

test("an answer that cannot be recorded is not sent to the subagent (#1702)", async () => {
  const m = machine();
  const a = m.process("s1", "proc-a");
  m.disk.full = true;
  let sent = false;
  const r = await a.sent.toAgent("a1", [{ text: LINE, ack: "d_1" }], async () => {
    sent = true;
    return { isDelivered: true };
  });
  expect(r.isDelivered).toBe(false);
  expect(sent).toBe(false);
});
