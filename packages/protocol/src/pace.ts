import type { Pace, QuotaAlert, QuotaWindow } from "./schemas";

/** Before this share of the window has passed, the rate is noise and the stage is "unknown". */
export const MIN_ELAPSED_FRACTION = 0.05;
/** How far from an even pace, in percentage points, still counts as on track. */
export const PACE_TOLERANCE = 5;

export interface AlertRule {
  /** Alert on unused headroom once the reset is this share of the window away. */
  leadFraction: number;
  /** Least headroom, in percent, worth an alert. */
  minUnusedPercent: number;
  unusedHeadroom: boolean;
  runsOut: boolean;
}

export const DEFAULT_ALERT_RULE: AlertRule = {
  leadFraction: 0.2,
  minUnusedPercent: 25,
  unusedHeadroom: true,
  runsOut: true,
};

const round1 = (x: number) => Math.round(x * 10) / 10;
/** ISO 8601 in UTC, whole seconds. */
const iso = (ms: number) => `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;

/**
 * Pace of one window at `now`, assuming usage keeps its average rate since the window began.
 * Null when the window's length or reset time is unknown.
 */
export function computePace(
  w: Pick<QuotaWindow, "usedPercent" | "windowMinutes" | "resetsAt">,
  now: Date,
): Pace | null {
  if (w.windowMinutes === null || w.resetsAt === null) return null;
  const length = w.windowMinutes * 60_000;
  const t = now.getTime();
  const remaining = Math.min(Math.max(Date.parse(w.resetsAt) - t, 0), length);
  const elapsed = length - remaining;
  const used = w.usedPercent;
  const expected = (elapsed / length) * 100;
  const delta = used - expected;

  if (used >= 100) {
    return {
      stage: "ahead",
      expectedUsedPercent: round1(expected),
      deltaPercent: round1(delta),
      projectedUsedPercent: round1(used),
      willLastToReset: false,
      runsOutAt: iso(t),
    };
  }
  if (elapsed < length * MIN_ELAPSED_FRACTION) {
    return {
      stage: "unknown",
      expectedUsedPercent: round1(expected),
      deltaPercent: round1(delta),
      projectedUsedPercent: null,
      willLastToReset: true,
      runsOutAt: null,
    };
  }
  const rate = used / elapsed;
  const projected = used + rate * remaining;
  const willLast = projected <= 100;
  return {
    stage: delta > PACE_TOLERANCE ? "ahead" : delta < -PACE_TOLERANCE ? "behind" : "on-track",
    expectedUsedPercent: round1(expected),
    deltaPercent: round1(delta),
    projectedUsedPercent: round1(projected),
    willLastToReset: willLast,
    runsOutAt: willLast ? null : iso(t + (100 - used) / rate),
  };
}

/**
 * Alerts for one window: it will run out before its reset, or it resets soon with headroom left
 * unused. The owner treats unused headroom as waste (GLM's 5-hour window, Mistral's monthly
 * credits, the Codex weekly limit).
 */
export function alertsFor(
  provider: string,
  w: Pick<QuotaWindow, "id" | "windowMinutes" | "resetsAt" | "pace" | "usedPercent">,
  now: Date,
  rule: AlertRule = DEFAULT_ALERT_RULE,
): QuotaAlert[] {
  const { pace, resetsAt, windowMinutes } = w;
  if (!pace || resetsAt === null || windowMinutes === null) return [];
  const alerts: QuotaAlert[] = [];
  if (
    rule.runsOut &&
    pace.runsOutAt !== null &&
    Date.parse(pace.runsOutAt) < Date.parse(resetsAt)
  ) {
    alerts.push({ kind: "runs-out", provider, window: w.id, resetsAt, runsOutAt: pace.runsOutAt });
  }
  const remaining = Date.parse(resetsAt) - now.getTime();
  const unused = round1(100 - Math.min(100, pace.projectedUsedPercent ?? w.usedPercent));
  if (
    rule.unusedHeadroom &&
    remaining > 0 &&
    remaining <= rule.leadFraction * windowMinutes * 60_000 &&
    unused >= rule.minUnusedPercent
  ) {
    alerts.push({
      kind: "unused-headroom",
      provider,
      window: w.id,
      resetsAt,
      unusedPercent: unused,
    });
  }
  return alerts;
}
