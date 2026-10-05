// What the page shows of runs: pure, so the state rules have tests. RUN_STALE_MS mirrors
// packages/protocol, which this module does not import to stay out of the first paint.
import type { RunItem } from "./types";

const RUN_STALE_MS = 3 * 60_000;
/** A finished or lost run stays on the page this long, so its result is seen. */
export const SHOWN_AFTER_MS = 30 * 60_000;

export type RunState = "running" | "passed" | "failed" | "lost";

/** Running until it exits; lost when its machine went quiet past RUN_STALE_MS. */
export function runState(r: RunItem["run"], now: number): RunState {
  if (r.exit) return r.exit.code === 0 ? "passed" : "failed";
  return now - Date.parse(r.at) > RUN_STALE_MS ? "lost" : "running";
}

/** Running runs, newest first, then the others still shown, latest news first. */
export function shownRuns(items: RunItem[], now: number): RunItem[] {
  const last = (i: RunItem) => Date.parse(i.run.exit?.at ?? i.run.at);
  const running = items
    .filter((i) => runState(i.run, now) === "running")
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
  const done = items
    .filter((i) => runState(i.run, now) !== "running" && now - last(i) <= SHOWN_AFTER_MS)
    .sort((a, b) => last(b) - last(a));
  return [...running, ...done];
}

/** "8 s", "2 min 05 s", "1 h 03 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} min`;
}

/** "3/7" for steps, "42%" for a percent. */
export function progressText(p: NonNullable<RunItem["run"]["progress"]>): string {
  return p.unit === "percent" ? `${p.done}%` : `${p.done}/${p.total}`;
}
