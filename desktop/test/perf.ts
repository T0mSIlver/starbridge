// Measures the app against its budgets (desktop/README.md, "Budgets") and fails when one is blown:
// cold start to a painted window, a warm open from the menu bar, idle memory, and download size.
//
//   node test/perf.ts [app]      app: a packaged binary (Starbridge.app/Contents/MacOS/Starbridge);
//                                by default the development build, through Electron.
//
// The window loads a stand-in page on this machine, so the network is not measured.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const DESKTOP = resolve(import.meta.dirname, "..");

// From GitHub's macos-15 runner (arm64), packaged, 2026-10-09: cold medians 407–555 ms (single
// launches from 290 ms to 1.5 s), warm 7–49 ms, 304 MB, 133 MB. Each budget leaves room for that
// noise, not for growth.
export const BUDGETS = {
  /** Process start to the window's first painted frame, median of the launches after the first. */
  coldMs: 700,
  /** Showing the hidden window to its next frame, as from the menu bar. */
  warmMs: 50,
  /** All processes' working sets, idle with the page loaded. */
  memoryMb: 350,
  /** The largest DMG. */
  downloadMb: 140,
};
/** Launches; the first is left out, since macOS checks a new binary then (1.2–2 s). */
const RUNS = 7;

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
const warm: number[] = [];
let memory = 0;
for (let i = 0; i < RUNS; i++) {
  const dir = mkdtempSync(join(tmpdir(), "sb-perf-"));
  const run = launch(dir);
  cold.push((await run.next("painted")).at);
  if (i === 0) {
    // Hidden a second after loading; a second launch hands over and shows it.
    await new Promise((r) => setTimeout(r, 1_500));
    for (let j = 0; j < 3; j++) {
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
  coldMs: median(cold.slice(1)),
  warmMs: median(warm),
  memoryMb: memory,
  downloadMb,
};
console.log(JSON.stringify({ result, budgets: BUDGETS, cold, warm, dmgs }));
for (const [k, budget] of Object.entries(BUDGETS)) {
  const got = result[k as keyof typeof result];
  if (k === "downloadMb" && dmgs.length === 0) continue;
  assert.ok(got <= budget, `${k}: ${got}, budget ${budget}`);
}
console.log("desktop budgets met");
