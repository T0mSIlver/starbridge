import type { Pace } from "./schemas";

/**
 * How the Quotas tab reads a window, the same in every client (#1904): where it is headed, the
 * word for its state, and the order windows come in. Android and iOS port these and pass
 * quotas.json; each client formats the times the words are about.
 */

/**
 * Where a window is headed by its reset, as the uploader computed it: "unused" only when the
 * uploader raised an unused-headroom alert for it, not whenever use runs behind an even pace.
 */
export type QuotaCourse = "unknown" | "runs-out" | "unused" | "even";

export function quotaCourse(
  pace: Pick<Pace, "stage" | "willLastToReset" | "runsOutAt"> | null | undefined,
  unusedAlert: boolean,
): QuotaCourse {
  if (!pace || pace.stage === "unknown") return "unknown";
  if (!pace.willLastToReset) return pace.runsOutAt === null ? "unknown" : "runs-out";
  return unusedAlert ? "unused" : "even";
}

/** A window as the Quotas tab places and words it. */
export type QuotaPlace = { course: QuotaCourse; runsOutAt: string | null; resetsAt: string | null };

/** The reset passed: the window's use and pace belong to the cycle that ended. */
const ended = (w: Pick<QuotaPlace, "resetsAt">, now: Date) =>
  w.resetsAt !== null && Date.parse(w.resetsAt) <= now.getTime();

/** What the state word says, and the colour it takes. */
export type QuotaState = "reset" | "unknown" | "ran-out" | "out" | "unused" | "ok";

export function quotaState(w: QuotaPlace, now: Date): QuotaState {
  if (ended(w, now)) return "reset";
  switch (w.course) {
    case "unknown":
      return "unknown";
    case "runs-out":
      return w.runsOutAt !== null && Date.parse(w.runsOutAt) <= now.getTime() ? "ran-out" : "out";
    case "unused":
      return "unused";
    case "even":
      return "ok";
  }
}

/**
 * The state's words (DESIGN.md: the words carry the state, never a colour alone). "Ran out" and
 * "Will run out" go on with when: "Ran out at 14:20", "Will run out in 50 min".
 */
export const QUOTA_STATE_WORDS: Record<QuotaState, string> = {
  reset: "Window reset",
  unknown: "Too early to tell",
  "ran-out": "Ran out",
  out: "Will run out",
  unused: "Headroom unused",
  ok: "On pace",
};

/** Will run out or ran out, and has not reset: what "Running out first" moves up. */
export const quotaRunningOut = (w: QuotaPlace, now: Date) =>
  w.course === "runs-out" && !ended(w, now);

export type QuotaOrder = {
  /** Providers in the order to show them; the ones not listed follow in the uploader's order. */
  order: string[];
  hidden: string[];
  /** Windows that will run out or ran out lead, else `order` holds for every window. */
  runningOutFirst: boolean;
};

/** Every provider the windows name, in the settings' order. */
export function quotaProviders(providers: string[], s: Pick<QuotaOrder, "order">): string[] {
  const seen = [...new Set(providers)];
  const known = s.order.filter((p) => seen.includes(p));
  return [...known, ...seen.filter((p) => !known.includes(p))];
}

/**
 * The windows to show (spec/items.md, "Quota order"): hidden providers out, the rest by provider
 * in the settings' order, a provider's machines by name (the server's order is by machine id,
 * which differs between accounts), each machine's windows in the uploader's order. With
 * `runningOutFirst`, windows that will run out or ran out, and have not reset, lead in that same
 * order. `compareNames` is the client's locale-aware comparison.
 */
export function arrangeQuotas<T>(
  windows: T[],
  s: QuotaOrder,
  of: (w: T) => { provider: string; machine?: string | null; runningOut: boolean },
  compareNames: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): T[] {
  const seen = windows.map(of);
  const rank = new Map(
    quotaProviders(
      seen.map((w) => w.provider),
      s,
    ).map((p, i) => [p, i]),
  );
  const lead = (i: number) => (s.runningOutFirst && seen[i]?.runningOut ? 0 : 1);
  return windows
    .map((w, i) => ({ w, i, v: seen[i] as ReturnType<typeof of> }))
    .filter(({ v }) => !s.hidden.includes(v.provider))
    .sort(
      (a, b) =>
        lead(a.i) - lead(b.i) ||
        (rank.get(a.v.provider) ?? 0) - (rank.get(b.v.provider) ?? 0) ||
        compareNames(a.v.machine ?? "", b.v.machine ?? "") ||
        a.i - b.i,
    )
    .map(({ w }) => w);
}
