/**
 * Load on the scratch stack through Caddy, the way the clients make it:
 *
 * - each user's machine holds the agent's answers long-poll (60 s), re-reads the directory every
 *   10 minutes, posts a decision now and then, a run with its updates, and a quota snapshot every
 *   5 minutes;
 * - the phone or the web page answers each decision after a while;
 * - a share of the users keep the web page open: its 20 s inbox and prompt polls, 10 s run poll,
 *   60 s quota poll and the join list long-poll (25 s).
 *
 * The users come from setup.ts. `--ramp 300,1000,3000` runs each count for `--stage` seconds,
 * stopping early once a stage's p99 passes 1 s or the server dies. At the end it stops posting,
 * waits for the last answers and decisions, and counts what was lost or came twice.
 *
 *   evals/load/stack.sh load --ramp 300,1000,3000 --stage 120 --procs 4
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { box, expMs, Hist, id, LOAD_DIR, type User } from "./lib.ts";

const { values } = parseArgs({
  options: {
    ramp: { type: "string", default: "100" },
    stage: { type: "string", default: "120" },
    procs: { type: "string", default: "4" },
    /** Share of users with the web page open. */
    pages: { type: "string", default: "1" },
    /** Decisions per user per hour; runs per user per hour. */
    decisions: { type: "string", default: "6" },
    runs: { type: "string", default: "4" },
    /** Mean seconds before a decision is answered. */
    answer: { type: "string", default: "60" },
    /** Seconds to wait for the last answers at the end. */
    drain: { type: "string", default: "90" },
    /** Run until this file exists instead of by stages (the failure tests). */
    until: { type: "string" },
    /** Only hold this many answer long-polls per machine: the memory each connection costs. */
    idle: { type: "string" },
    worker: { type: "string" },
    out: { type: "string" },
  },
});

const WINDOW_MS = 10_000;
/** Caddy, as the load container reaches it on the stack's network (stack.sh load). */
const TARGET = process.env.LOAD_TARGET ?? "http://caddy:18000";
/** The host's cgroup tree, mounted into the load container. */
const CGROUPS = process.env.LOAD_CGROUPS ?? "/sys/fs/cgroup";
/** One operation's window as a worker sends it. */
type WorkerOp = { hist: { counts: (number | null)[]; n: number }; errors: Record<string, number> };
const ramp = values.ramp.split(",").map(Number);
const stageMs = Number(values.stage) * 1000;
// Long-polls wait by design: their time is not latency.
const WAITS = new Set(["answers.wait", "joins.wait"]);

// --- Worker: drives the users n % procs == index -------------------------------------------

async function worker(index: number, procs: number) {
  const all = readFileSync(`${LOAD_DIR}/users.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as User)
    .slice(0, Math.max(...ramp))
    .filter((u) => u.n % procs === index);

  type Op = { hist: Hist; errors: Record<string, number> };
  let ops = new Map<string, Op>();
  let delivery = new Hist();
  const op = (name: string) => {
    const o = ops.get(name) ?? { hist: new Hist(), errors: {} };
    ops.set(name, o);
    return o;
  };
  // Answers posted (id -> when) and received by machines; decisions posted and seen by pages.
  const answers = new Map<string, number>();
  const got = new Map<string, number>();
  const acked = new Set<string>();
  const decisions = new Map<string, boolean>();
  let decisionsSeen = 0;
  let posting = true;
  let stopped = false;

  async function call(
    name: string,
    u: User,
    token: string,
    method: string,
    path: string,
    body?: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: each caller reads the fields it asked for
  ): Promise<{ status: number; json?: any }> {
    const t = performance.now();
    try {
      const res = await fetch(
        `${TARGET}${path === "/" ? "" : "/v1"}${path}`,
        {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      const text = await res.text();
      op(name).hist.add(performance.now() - t);
      if (res.status >= 400) op(name).errors[res.status] = (op(name).errors[res.status] ?? 0) + 1;
      return {
        status: res.status,
        json:
          text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined,
      };
    } catch (e) {
      op(name).hist.add(performance.now() - t);
      const code = (e as { code?: string }).code ?? "net";
      op(name).errors[code] = (op(name).errors[code] ?? 0) + 1;
      return { status: 0 };
    }
  }

  /** A post retried with the same id until the server has it; 409 means an earlier try landed. */
  async function post(name: string, u: User, token: string, item: unknown): Promise<boolean> {
    for (let wait = 1000; !stopped; wait = Math.min(wait * 2, 30_000)) {
      const r = await call(name, u, token, "POST", "/items", item);
      if (r.status === 201 || r.status === 409) return true;
      if (r.status === 429 || (r.status >= 400 && r.status < 500)) return false;
      await Bun.sleep(wait);
    }
    return false;
  }

  const pause = (ms: number) => Bun.sleep(ms);

  async function machine(u: User) {
    let cursor = "";
    let first = true;
    let failures = 0;
    let dirAt = Date.now();
    while (!stopped) {
      if (Date.now() - dirAt > 600_000) {
        await call("directory", u, u.machine, "GET", "/directory");
        dirAt = Date.now();
      }
      const q = `wait=${first ? 0 : 60}&directory=${u.directory}${cursor ? `&after=${cursor}` : ""}`;
      const r = await call(
        first ? "answers" : "answers.wait",
        u,
        u.machine,
        "GET",
        `/answers?${q}`,
      );
      if (r.status !== 200) {
        failures++;
        await pause(Math.min(60_000, 2000 * 2 ** (failures - 1)));
        continue;
      }
      failures = 0;
      for (const s of r.json.items as { item: { id: string } }[]) {
        const at = answers.get(s.item.id);
        if (at === undefined) continue; // from an earlier run
        got.set(s.item.id, (got.get(s.item.id) ?? 0) + 1);
        if (got.get(s.item.id) === 1) delivery.add(Date.now() - at);
      }
      cursor = r.json.cursor;
      // Catches up on earlier runs' answers before waiting.
      if (first && r.json.items.length === 100) continue;
      first = false;
    }
  }

  async function ask(u: User) {
    await pause((Math.random() * 3_600_000) / Number(values.decisions));
    while (posting) {
      const d = id("d");
      const item = {
        v: 1,
        kind: "decision",
        id: d,
        from: "mac",
        boxes: [
          { to: "phone", box: box(1500) },
          { to: "web", box: box(1500) },
        ],
      };
      if (await post("post.decision", u, u.machine, item)) {
        decisions.set(d, false);
        answerLater(u, d);
      }
      await pause(expMs(3_600_000 / Number(values.decisions)));
    }
  }

  async function answerLater(u: User, decision: string) {
    await pause(expMs(Number(values.answer) * 1000));
    const [from, token] = Math.random() < 0.5 ? ["phone", u.phone] : ["web", u.web];
    const a = id("a");
    const item = {
      v: 1,
      kind: "answer",
      id: a,
      from,
      re: decision,
      boxes: [{ to: "mac", box: box(600) }],
    };
    // Counted from the first try: what the waiting session sees.
    answers.set(a, Date.now());
    if (await post("post.answer", u, token, item)) acked.add(a);
    else answers.delete(a);
  }

  async function quotas(u: User) {
    await pause(Math.random() * 300_000);
    while (posting) {
      const quiet = Math.random() < 0.9 ? { quiet: true } : {};
      await post("post.quota", u, u.machine, {
        v: 1,
        kind: "quota",
        id: id("q"),
        from: "mac",
        ...quiet,
        boxes: [
          { to: "phone", box: box(2000) },
          { to: "web", box: box(2000) },
        ],
      });
      await pause(300_000 * (0.9 + Math.random() * 0.2));
    }
  }

  async function runs(u: User) {
    await pause((Math.random() * 3_600_000) / Number(values.runs));
    while (posting) {
      const r = id("r");
      for (let step = 0; step < 6 && posting; step++) {
        await post("post.run", u, u.machine, {
          v: 1,
          kind: "run",
          id: r,
          from: "mac",
          boxes: [
            { to: "phone", box: box(1000) },
            { to: "web", box: box(1000) },
          ],
        });
        await pause(20_000);
      }
      await pause(expMs(3_600_000 / Number(values.runs)));
    }
  }

  async function page(u: User) {
    const cursors = { inbox: "", settled: "", runs: "" };
    const after = (c: string) => (c ? `&after=${c}` : "");
    const every = async (ms: number, f: () => Promise<void>) => {
      await pause(Math.random() * ms);
      while (!stopped) {
        await f();
        await pause(ms);
      }
    };
    const joins = async () => {
      let c = "0";
      while (!stopped) {
        const r = await call("joins.wait", u, u.web, "GET", `/joins?after=${c}&wait=25`);
        if (r.status === 200) c = r.json.cursor;
        else await pause(5000);
      }
    };
    await Promise.all([
      joins(),
      every(20_000, async () => {
        for (;;) {
          const r = await call(
            "poll.inbox",
            u,
            u.web,
            "GET",
            `/items?kind=decision,settled,waiting${after(cursors.inbox)}`,
          );
          if (r.status !== 200) return;
          for (const s of r.json.items as { item: { id: string } }[])
            if (decisions.get(s.item.id) === false) {
              decisions.set(s.item.id, true);
              decisionsSeen++;
            }
          cursors.inbox = r.json.cursor;
          if (r.json.items.length < 100) break;
        }
        await call("poll.prompts", u, u.web, "GET", "/items?kind=permission&open=1");
        const s = await call(
          "poll.settled",
          u,
          u.web,
          "GET",
          `/items?kind=settled${after(cursors.settled)}`,
        );
        if (s.status === 200) cursors.settled = s.json.cursor;
      }),
      every(10_000, async () => {
        const r = await call("poll.runs", u, u.web, "GET", `/items?kind=run${after(cursors.runs)}`);
        if (r.status === 200) cursors.runs = r.json.cursor;
      }),
      every(60_000, async () => {
        await call("poll.quota", u, u.web, "GET", "/quota");
      }),
      // Someone opens or reloads the page now and then: the web copies' share of the load.
      every(300_000, async () => {
        await call("page", u, "", "GET", "/");
      }),
    ]);
  }

  process.stdout.on("error", () => process.exit(0)); // the parent is gone
  const started = new Set<number>();
  const t0 = Date.now();
  const startUsers = () => {
    const stage = values.until
      ? ramp.length - 1
      : Math.min(ramp.length - 1, Math.floor((Date.now() - t0) / stageMs));
    const want = ramp[stage] as number;
    for (const u of all) {
      if (u.n >= want || started.has(u.n)) continue;
      started.add(u.n);
      // Spread over a few seconds, as real clients would arrive.
      setTimeout(() => {
        if (values.idle) {
          for (let k = 0; k < Number(values.idle); k++) machine(u);
          return;
        }
        machine(u);
        ask(u);
        quotas(u);
        runs(u);
        if ((u.n * 0.618) % 1 < Number(values.pages)) page(u);
      }, Math.random() * 5000);
    }
  };
  startUsers();
  const tick = setInterval(() => {
    startUsers();
    const out = Object.fromEntries([...ops].map(([k, v]) => [k, v]));
    try {
      process.stdout.write(`${JSON.stringify({ users: started.size, ops: out, delivery })}\n`);
    } catch {
      process.exit(0); // the parent is gone
    }
    ops = new Map();
    delivery = new Hist();
  }, WINDOW_MS);

  // The parent says when to stop posting (stdin "drain") and when to stop altogether.
  for await (const chunk of Bun.stdin.stream()) {
    const msg = new TextDecoder().decode(chunk);
    if (msg.includes("drain")) {
      posting = false;
      // Answers still scheduled get posted during the drain; wait them out, then count.
      const end = Date.now() + Number(values.drain) * 1000;
      while (Date.now() < end && [...answers.keys()].some((a) => !got.has(a))) await pause(1000);
      // Pages poll every 20 s: give them one more round.
      await pause(25_000);
      stopped = true;
      clearInterval(tick);
      // Lost: the server took it (201 or 409) and no machine got it. An answer still being
      // retried when the run ends was never taken: it counts as unacked, not lost.
      const lostIds = [...acked].filter((a) => !got.has(a));
      const lost = lostIds.length;
      const unacked = [...answers.keys()].filter((a) => !acked.has(a)).length;
      const unseenIds = [...decisions].filter(([, seen]) => !seen).map(([d]) => d);
      const dup = [...got.values()].filter((n) => n > 1).length;
      const unseen = unseenIds.length;
      const pages = all.filter(
        (u) => started.has(u.n) && (u.n * 0.618) % 1 < Number(values.pages),
      ).length;
      process.stdout.write(
        `${JSON.stringify({ final: { answers: answers.size, unacked, received: got.size, lost, dup, decisions: decisions.size, decisionsSeen, unseen, pages }, lostIds, unseenIds })}\n`,
      );
      process.exit(0);
    }
  }
}

// --- Parent: spawns the workers, merges their windows, watches the containers ----------------

async function parent() {
  const procs = Number(values.procs);
  const kids = Array.from({ length: procs }, (_, i) =>
    Bun.spawn(
      [process.execPath, import.meta.path, ...process.argv.slice(2), "--worker", `${i}/${procs}`],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        // Bun runs at most 256 fetches at once by default, and long-polls take most of them.
        env: { ...process.env, BUN_CONFIG_MAX_HTTP_REQUESTS: "65535" },
      },
    ),
  );
  const containers = await containerIds();

  let cpuWas = await cpuUsage(containers);
  const log: string[] = [];
  const say = (s: string) => {
    console.log(s);
    log.push(s);
  };

  type Window = {
    users: number;
    ops: Map<string, { hist: Hist; errors: Record<string, number> }>;
    delivery: Hist;
  };
  let win: Window = { users: 0, ops: new Map(), delivery: new Hist() };
  let reports = 0;
  let stageWins: Window[] = [];
  const finals: Record<string, number>[] = [];
  const lostIds: string[] = [];
  let resolveFinal: () => void = () => {};
  const allFinal = new Promise<void>((r) => (resolveFinal = r));

  for (const kid of kids)
    (async () => {
      let buf = "";
      for await (const chunk of kid.stdout) {
        buf += new TextDecoder().decode(chunk);
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (line.final) {
            finals.push(line.final);
            lostIds.push(...line.lostIds, ...line.unseenIds);
            if (finals.length === procs) resolveFinal();
            continue;
          }
          win.users += line.users;
          for (const [k, v] of Object.entries(line.ops) as [string, WorkerOp][]) {
            const o = win.ops.get(k) ?? { hist: new Hist(), errors: {} };
            win.ops.set(k, o);
            o.hist.merge(v.hist);
            for (const [code, n] of Object.entries(v.errors))
              o.errors[code] = (o.errors[code] ?? 0) + n;
          }
          win.delivery.merge(line.delivery);
          if (++reports % procs === 0) {
            stageWins.push(win);
            win = { users: 0, ops: new Map(), delivery: new Hist() };
          }
        }
      }
    })();

  const t0 = Date.now();
  const summarize = (ws: Window[]) => {
    const req = new Hist();
    const errors: Record<string, number> = {};
    let n = 0;
    const perOp = new Map<string, Hist>();
    for (const w of ws)
      for (const [k, o] of w.ops) {
        n += o.hist.n;
        for (const [c, m] of Object.entries(o.errors))
          errors[`${k}:${c}`] = (errors[`${k}:${c}`] ?? 0) + m;
        if (WAITS.has(k)) continue;
        req.merge(o.hist);
        if (!perOp.has(k)) perOp.set(k, new Hist());
        perOp.get(k)?.merge(o.hist);
      }
    const delivery = new Hist();
    for (const w of ws) delivery.merge(w.delivery);
    return { req, n, errors, perOp, delivery, secs: (ws.length * WINDOW_MS) / 1000 };
  };

  // The failure tests: a page load and a server call every 100 ms, to see any request fail.
  const probe = { sent: 0, failed: 0, slowest: 0 };
  if (values.until)
    (async () => {
      while (true) {
        for (const url of [`${TARGET}/`, `${TARGET}/healthz`]) {
          const t = performance.now();
          const ok = await fetch(url).then(
            (r) => r.ok,
            () => false,
          );
          probe.sent++;
          if (!ok) probe.failed++;
          probe.slowest = Math.max(probe.slowest, performance.now() - t);
        }
        await Bun.sleep(100);
      }
    })();
  let broke = "";
  const stages = values.until ? [ramp.at(-1) as number] : ramp;
  for (const [i, users] of stages.entries()) {
    stageWins = [];
    const stageEnd = values.until ? Infinity : t0 + (i + 1) * stageMs;
    let peakMem = 0;
    while (Date.now() < stageEnd) {
      if (values.until && (await Bun.file(values.until).exists())) break;
      await Bun.sleep(WINDOW_MS);
      // A deploy or a kill makes new containers.
      Object.assign(containers, await containerIds());
      const mem = await memory(containers);
      const cpu = await cpuUsage(containers);
      const cpuPct = Object.fromEntries(
        Object.entries(cpu).map(([k, v]) => [
          k,
          ((v - (cpuWas[k] ?? 0)) / 1e4 / (WINDOW_MS / 1000)).toFixed(0),
        ]),
      );
      cpuWas = cpu;
      peakMem = Math.max(peakMem, mem.server ?? 0);
      const last = stageWins.at(-1);
      const s = last ? summarize([last]) : undefined;
      say(
        `t=${((Date.now() - t0) / 1000).toFixed(0)}s users=${last?.users ?? 0} rps=${s ? (s.n / s.secs).toFixed(0) : 0} p50=${s?.req.q(0.5).toFixed(0)} p99=${s?.req.q(0.99).toFixed(0)}ms answer p99=${s?.delivery.q(0.99).toFixed(0)}ms mem MB ${fmt(mem)} cpu% ${JSON.stringify(cpuPct)} errors ${JSON.stringify(s?.errors ?? {})}`,
      );
      if (!values.until && (await died())) {
        broke = `server died (${await died()}) at ${users} users`;
        break;
      }
    }
    // The stage's second half, once the users it added have settled in; all of a failure test.
    const s = summarize(stageWins.slice(values.until ? 0 : Math.floor(stageWins.length / 2)));
    const ops = [...s.perOp].map(([k, h]) => `${k} ${h.q(0.99).toFixed(0)}`).join(", ");
    say(
      `STAGE users=${users} rps=${(s.n / s.secs).toFixed(0)} p50=${s.req.q(0.5).toFixed(0)}ms p99=${s.req.q(0.99).toFixed(0)}ms answer delivery p50=${s.delivery.q(0.5).toFixed(0)} p99=${s.delivery.q(0.99).toFixed(0)}ms peak server mem=${peakMem.toFixed(0)} MB errors=${JSON.stringify(s.errors)}\n  p99 by op (ms): ${ops}`,
    );
    if (broke) break;
    if (s.req.q(0.99) > 1000) {
      broke = `p99 passed 1 s at ${users} users`;
      break;
    }
  }
  say(broke ? `BROKE: ${broke}` : "held every stage");
  for (const k of kids) {
    k.stdin.write("drain\n");
    k.stdin.flush();
  }
  await Promise.race([allFinal, Bun.sleep((Number(values.drain) + 60) * 1000)]);
  const total = finals.reduce(
    (a, f) => {
      for (const [k, v] of Object.entries(f)) a[k] = (a[k] ?? 0) + (v as number);
      return a;
    },
    {} as Record<string, number>,
  );
  say(`FINAL ${JSON.stringify(total)}`);
  // Answers no machine got and decisions no page saw: whether the server holds them tells late
  // from lost (README.md, "Lost or late").
  await Bun.write(`${LOAD_DIR}/lost.txt`, lostIds.join("\n"));
  if (values.until)
    say(`PROBE ${JSON.stringify({ ...probe, slowest: Math.round(probe.slowest) })}`);
  if (values.out) await Bun.write(values.out, `${log.join("\n")}\n`);
  for (const k of kids) k.kill();
  process.exit(0);
}

function fmt(m: Record<string, number>) {
  return Object.entries(m)
    .map(([k, v]) => `${k}=${v.toFixed(0)}`)
    .join(" ");
}

const NAMES = ["server", "caddy", "web-a", "web-b"];

/** A container's state from the Docker API, through the socket stack.sh mounts. */
async function inspect(name: string) {
  const res = await fetch(`http://docker/containers/starbridge-load-${name}-1/json`, {
    unix: "/var/run/docker.sock",
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  return (await res.json()) as {
    Id: string;
    RestartCount: number;
    State: { Status: string; OOMKilled: boolean };
  };
}

async function containerIds(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of NAMES) {
    const c = await inspect(n);
    if (c) out[n] = c.Id;
  }
  return out;
}

async function cgroupRead(id: string, file: string): Promise<string | undefined> {
  // Bun.file reads cgroup files as empty: they report size 0.
  try {
    return readFileSync(`${CGROUPS}/system.slice/docker-${id}.scope/${file}`, "utf8");
  } catch {
    return undefined;
  }
}

/** Each container's memory in MB, page cache left out, as the OOM killer would see it. */
async function memory(ids: Record<string, string>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [n, id] of Object.entries(ids)) {
    const cur = await cgroupRead(id, "memory.current");
    const stat = await cgroupRead(id, "memory.stat");
    if (!cur || !stat) continue;
    const file = Number(/^file (\d+)/m.exec(stat)?.[1] ?? 0);
    out[n] = (Number(cur) - file) / 1048576;
  }
  return out;
}

/**
 * Each container's CPU time and its time spent waiting for a core, in µs. On a shared machine
 * the wait shows when other processes starve the stack: windows with much of it measure the
 * machine, not the stack.
 */
async function cpuUsage(ids: Record<string, string>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [n, id] of Object.entries(ids)) {
    const stat = await cgroupRead(id, "cpu.stat");
    if (stat) out[n] = Number(/^usage_usec (\d+)/m.exec(stat)?.[1] ?? 0);
    const pressure = await cgroupRead(id, "cpu.pressure");
    if (pressure) out[`${n} wait`] = Number(/^some .*total=(\d+)/m.exec(pressure)?.[1] ?? 0);
  }
  return out;
}

/** Why the server is down, if it is: OOM-killed, or no longer running. */
async function died(): Promise<string | undefined> {
  const c = await inspect("server");
  if (!c) return "gone";
  if (c.State.OOMKilled) return "OOM-killed";
  if (c.State.Status !== "running") return c.State.Status;
  if (c.RestartCount) return `restarted ${c.RestartCount} times`;
  return undefined;
}

if (values.worker !== undefined)
  await worker(...(values.worker.split("/").map(Number) as [number, number]));
else await parent();
