import { expect, test } from "bun:test";
import { compare } from "./compare.ts";
import type { LoadResult, StageResult } from "./lib.ts";

const stage = (o: Partial<StageResult> = {}): StageResult => ({
  users: 1000,
  rps: 900,
  p50: 8,
  p99: 120,
  deliveryP50: 40,
  deliveryP99: 400,
  errorRate: 0,
  peakMB: { server: 300, caddy: 200 },
  cpuPct: {},
  p99ByOp: {},
  ...o,
});
const run = (o: Partial<LoadResult> = {}): LoadResult => ({
  at: "",
  stages: [stage()],
  final: { lost: 0, dup: 0, unseen: 0 },
  memory: [],
  ...o,
});
/** A soak's memory samples: `mb(hour)` every 5 minutes for `hours`. */
const soak = (hours: number, mb: (h: number) => number) =>
  Array.from({ length: hours * 12 + 1 }, (_, i) => ({ t: i * 300, mb: { server: mb(i / 12) } }));

test("run-to-run noise is no regression", () => {
  const noisy = stage({
    p99: 160,
    deliveryP99: 590,
    peakMB: { server: 360, caddy: 250 },
    errorRate: 0.0005,
  });
  expect(compare(run({ stages: [noisy] }), run())).toEqual([]);
});

test("names a slower p99, more memory, errors, lost answers and a broken stage", () => {
  const now = run({
    stages: [stage({ p99: 400, peakMB: { server: 500, caddy: 200 }, errorRate: 0.01 })],
    final: { lost: 3, dup: 0, unseen: 0 },
    broke: "p99 passed 1 s at 3000 users",
  });
  expect(compare(now, run())).toEqual([
    "broke: p99 passed 1 s at 3000 users",
    "lost: 3 (baseline 0)",
    "1000 users: p99 400 ms (baseline 120 ms)",
    "1000 users: server peak memory 500 MB (baseline 300 MB)",
    "1000 users: errors 1.00% of requests (baseline 0.00%)",
  ]);
});

test("a soak whose server memory keeps growing, past the baseline's growth", () => {
  const base = run({ memory: soak(24, (h) => 300 + Math.min(h, 1) * 50) });
  expect(compare(run({ memory: soak(24, (h) => 300 + h * 10) }), base)).toEqual([
    "server memory grew 220 MB over the soak (baseline 0 MB)",
  ]);
  expect(compare(run({ memory: soak(24, (h) => 320 + Math.min(h, 1) * 50) }), base)).toEqual([]);
});
