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

/**
 * "about 12 min left": when the run ends at the pace it kept from its start to its last update,
 * counted down to `now`. None before 30 s or the first step, since an early pace misleads, and none
 * once every step is done. Overdue reads "under a minute left" (#2259).
 */
export function timeLeft(r: RunItem["run"], now: number): string | null {
  const p = r.progress;
  if (!p || p.done === 0 || p.done >= p.total) return null;
  const start = Date.parse(r.startedAt);
  const last = Date.parse(r.at);
  if (last - start < LEFT_AFTER_MS) return null;
  const end = last + ((last - start) * (p.total - p.done)) / p.done;
  const min = Math.ceil((end - now) / 60_000);
  if (min <= 1) return "under a minute left";
  if (min < 60) return `about ${min} min left`;
  return `about ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min left`;
}

/** A run's pace says nothing before this much of it has passed. */
export const LEFT_AFTER_MS = 30_000;

/** "34 of 120 · about 12 min left", "40%": what a running run's bar has under it. */
export function runCaption(r: RunItem["run"], now: number): string | null {
  const p = r.progress;
  if (!p) return null;
  const count = p.unit === "percent" ? `${p.done}%` : `${p.done} of ${p.total}`;
  const left = timeLeft(r, now);
  return left ? `${count} · ${left}` : count;
}

/**
 * The runs to notify about, as on Android: each that passed or failed, once. A lost run notifies
 * nothing, and one that ended before the page shows it ([SHOWN_AFTER_MS]) is old news.
 */
export function runsToNotify(items: RunItem[], shown: string[], now: number): RunItem[] {
  return items.filter(
    (i) =>
      i.run.exit && now - Date.parse(i.run.exit.at) <= SHOWN_AFTER_MS && !shown.includes(runKey(i)),
  );
}

/** One key per run's end, so a run its machine runs again under the same id notifies again. */
export const runKey = (i: RunItem) => `${i.run.id}/${i.run.exit?.at ?? ""}`;

/**
 * How an ended run ended: "Passed in 8 s", "Failed, exit 1, after 2 min 05 s", "Killed (SIGKILL),
 * after 2 min 05 s", or "Lost, no news
 * for 3 min 37 s", with no length since its last news may predate most of it (#190). The same
 * words on every client, in vectors/rules.json (`runEnd`). None while it runs.
 */
export function runEnd(r: RunItem["run"], now: number): string | null {
  const took = duration(Date.parse(r.exit?.at ?? r.at) - Date.parse(r.startedAt));
  switch (runState(r, now)) {
    case "passed":
      return `Passed in ${took}`;
    case "failed":
      return `${failure(r.exit?.code ?? 1)}, after ${took}`;
    case "lost":
      return `Lost, no news for ${duration(now - Date.parse(r.at))}`;
    default:
      return null;
  }
}

/** Signals that mean the same on Linux and macOS, by number: what a run they ended reads. */
const SIGNALS: Record<number, string> = {
  1: "Stopped (SIGHUP)",
  2: "Interrupted (Ctrl-C)",
  6: "Crashed (SIGABRT)",
  9: "Killed (SIGKILL)",
  11: "Crashed (SIGSEGV)",
  15: "Stopped (SIGTERM)",
};

/**
 * Why a run failed, from its exit code alone (#2259): 126 and 127 are the shell's, and 128 + n
 * means signal n ended it. Any other code says only its number.
 */
function failure(code: number): string {
  if (code === 126) return "Failed, exit 126, not executable";
  if (code === 127) return "Failed, exit 127, command not found";
  if (code > 128 && code < 160) return SIGNALS[code - 128] ?? `Ended by signal ${code - 128}`;
  return `Failed, exit ${code}`;
}

/** How the run ended, then the machine and project, then why. */
export function runNote(i: RunItem): { title: string; body: string } {
  const r = i.run;
  const outcome = runEnd(r, Date.parse(r.exit?.at ?? r.at));
  const where = [r.source.machine, r.source.project].filter(Boolean).join(" · ");
  return { title: r.title, body: `${outcome}\n${where}\n${r.reason}` };
}
