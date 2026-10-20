// Measures the app against its budgets (desktop/README.md, "Budgets") and fails when one is blown:
// cold start to a painted window, a warm open from the menu bar, idle memory, and download size.
//
//   node test/perf.ts [app]      app: a packaged binary (Starbridge.app/Contents/MacOS/Starbridge);
//                                by default the development build, through Electron.
//
// The window loads a stand-in page on this machine, so the network is not measured.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const DESKTOP = resolve(import.meta.dirname, "..");

// From GitHub's macos-15 runner (arm64), packaged. A whole job can land on a slow runner, every
// launch up to twice as long: cold medians of 433–889 ms in 16 runs on 2026-10-20 to 10-21,
// 272–982 ms in 104 runs 2026-10-08 to 10-11, and 1270 ms once (#2180, #1119). Such a run is slow
// throughout, so the cold start is budgeted as a ratio to a span the app does not own
// (`coldRatio`), which slows with it. The warm budget's numbers are on `warmMs`.
export const BUDGETS = {
  /**
   * Process start to the window's first painted frame over process start to the app's first line
   * (the `main` mark: Electron's own boot and the bundle's load), median of the launches after
   * the first. Both spans stretch with the runner, so the ratio holds: 4.56–5.32 over 16 runs
   * whose cold medians ran 433–889 ms (2.05 times apart), where the `main` mark ran 80–219 ms.
   * 7 sits 1.3 times above the slowest run; the app's own part (the ratio less 1, 3.6–4.3 in those
   * runs) can grow 1.4 times before it fails even on the slowest of them, and 1.6 times on a
   * typical one, on any runner.
   * The ratio assumes a runner slow throughout, as a host with a slower CPU is. Eight busy
   * processes on the runner's cores are not that: they starve the renderer more than the main
   * process, and gave ratios of 8.6 and 10.8 (#2180).
   */
  coldRatio: 7,
  /**
   * Process start to the first painted frame, median of the launches after the first. What the
   * ratio cannot see is Electron's boot and the bundle's load getting slower, since `main` is
   * their yardstick: this ceiling, 2.2 times the slowest of 16 runs and 1.6 times the slowest of
   * 94 earlier ones, catches those once they are large. Before #2180 it was 1000, and a run on a
   * slow runner failed it (1270 ms) with nothing in the app changed.
   */
  coldMs: 2000,
  /**
   * Showing the hidden window to its next frame, as from the menu bar, median of `OPENS`, timed
   * in the page. Timed in the main process until #2136, it counted the page's answer coming
   * back, 9 ms at the median and up to 36 ms on GitHub's runner: two runs of 183 (2026-10-11
   * to 10-20) went over 80 that way. Timed in the page, 15 runs on 2026-10-20 had medians of
   * 26–50 ms (median 39), so 80 sits 1.6 times above the slowest.
   */
  warmMs: 80,
  /**
   * All processes' working sets, idle with the page loaded. 350 MB is the runner's gate; a real
   * Mac uses more, so its budget is 400 MB (owner, 2026-10-09: the Mac Mini M2 measured 371–378 MB
   * on main 12df3fee, the updater ~23 MB of it, kept).
   */
  memoryMb: 350,
  /** The largest DMG. */
  downloadMb: 140,
};
/**
 * Launches; the first is left out, since macOS checks a new binary then (1.2–2 s). The 13 counted
 * give a true middle sample, and the runner's slow launches (up to 1.2 s, in bursts) must then be
 * 7 of them to move it: run 37949475260 failed on 6 counted, 3 of them slow (#924).
 */
const RUNS = 14;
/** Warm opens; 3 let two slow ones (85 and 72 ms, run 38102546726) set the median. */
const OPENS = 9;

type Mark = { name: string; at: number; ms?: number; mb?: number };

const server = createServer((_req, res) =>
  res.setHeader("content-type", "text/html").end("<!doctype html><title>stand-in</title><p>Inbox"),
);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const app = process.argv[2];
const command = app ?? ((await import("electron")).default as unknown as string);
const args = (dir: string) => [...(app ? [] : [DESKTOP]), `--user-data-dir=${dir}`];
const env = { ...process.env, STARBRIDGE_TIMING: "1", STARBRIDGE_SERVER: origin };

/** Launches the app and returns its marks as they come, and a way to stop it. */
function launch(dir: string) {
  // A packaged app ignores STARBRIDGE_SERVER (#1721): its server comes from its settings.
  const saved = join(dir, "settings.json");
  if (app && !existsSync(saved)) writeFileSync(saved, JSON.stringify({ server: origin }));
  const child = spawn(command, args(dir), { env, stdio: ["ignore", "pipe", "inherit"] });
  // Listened for at once: a second instance hands over and quits before anyone asks.
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const marks: Mark[] = [];
  const waiters: { name: string; done: (m: Mark) => void }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("timing ")) return;
    const m = JSON.parse(line.slice(7)) as Mark;
    marks.push(m);
    for (const w of waiters.filter((w) => w.name === m.name)) w.done(m);
  });
  const next = (name: string, ms = 30_000) =>
    new Promise<Mark>((done, fail) => {
      const t = setTimeout(() => fail(new Error(`no "${name}" mark in ${ms} ms`)), ms);
      waiters.push({
        name,
        done: (m) => {
          clearTimeout(t);
          done(m);
        },
      });
    });
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return exited;
  };
  return { marks, next, stop };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

const cold: number[] = [];
const coldRatios: number[] = [];
const warm: number[] = [];
let memory = 0;
for (let i = 0; i < RUNS; i++) {
  const dir = mkdtempSync(join(tmpdir(), "sb-perf-"));
  const run = launch(dir);
  const painted = (await run.next("painted")).at;
  cold.push(painted);
  // `main` is printed before `painted`, so it is in the marks by now.
  coldRatios.push(painted / (run.marks.find((m) => m.name === "main")?.at ?? Number.NaN));
  if (i === 0) {
    // Hidden a second after loading; a second launch hands over and shows it.
    await new Promise((r) => setTimeout(r, 1_500));
    for (let j = 0; j < OPENS; j++) {
      const opened = run.next("opened");
      const again = launch(dir);
      warm.push((await opened).ms as number);
      await again.stop().catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
    memory = (await run.next("memory", 20_000)).mb as number;
  }
  await run.stop();
}
server.close();

const dmgs = (() => {
  try {
    return readdirSync(join(DESKTOP, "release")).filter((f) => f.endsWith(".dmg"));
  } catch {
    return [];
  }
})();
const downloadMb = Math.max(
  0,
  ...dmgs.map((f) => Math.round(statSync(join(DESKTOP, "release", f)).size / 1e6)),
);

const result = {
  coldRatio: Math.round(median(coldRatios.slice(1)) * 100) / 100,
  coldMs: median(cold.slice(1)),
  warmMs: median(warm),
  memoryMb: memory,
  downloadMb,
};
console.log(JSON.stringify({ result, budgets: BUDGETS, cold, coldRatios, warm, dmgs }));
for (const [k, budget] of Object.entries(BUDGETS)) {
  const got = result[k as keyof typeof result];
  if (k === "downloadMb" && dmgs.length === 0) continue;
  assert.ok(got <= budget, `${k}: ${got}, budget ${budget}`);
}
console.log("desktop budgets met");
