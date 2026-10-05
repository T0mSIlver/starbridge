// Quota settings, per browser (SPEC.md, "Quota settings follow CodexBar"): a curated set of
// CodexBar's own settings with CodexBar's meaning. They stay in this browser; the server learns
// nothing of them. Android keeps the same set (QuotaSettings.kt).
import { clockTime, relative } from "./format";
import type { QuotaAlert, QuotaCardData, QuotaWindow } from "./types";

export type Ticks = "subtle" | "high-contrast" | "hidden";

export type QuotaSettings = {
  /** The bar and the percentage show used, else remaining (CodexBar `usageBarsShowUsed`). */
  showUsed: boolean;
  /** Reset times as a clock time, else "in 2 h" (`resetTimesShowAbsolute`). */
  absoluteResets: boolean;
  /** Workdays a week on weekly bars: Monday on (`weeklyProgressWorkDays`); null is off. */
  workDays: 4 | 5 | 7 | null;
  /** How the workday ticks show (`workdayTickAppearance`). */
  ticks: Ticks;
  /** Providers in the order to show them; the ones not listed follow in the uploader's order. */
  order: string[];
  /** Windows that will run out or ran out lead, else `order` holds for every window. */
  runningOutFirst: boolean;
  hidden: string[];
  /** Providers whose alerts notify; none by default. */
  notify: string[];
  /** Notify when a window reaches 50% or 20% left (`quotaWarningThresholds`). */
  notifyLow: boolean;
  /** Notify when a window will run out, or reset with headroom unused (`predictivePaceWarning…`). */
  notifyPace: boolean;
};

export const DEFAULT_SETTINGS: QuotaSettings = {
  showUsed: true,
  absoluteResets: false,
  workDays: null,
  ticks: "subtle",
  order: [],
  runningOutFirst: true,
  hidden: [],
  notify: [],
  notifyLow: true,
  notifyPace: true,
};

const KEY = "starbridge:quota-settings";

export function loadSettings(): QuotaSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<QuotaSettings>) }
      : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: QuotaSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private windows may refuse storage; the settings then last for this page.
  }
}

/** Every provider the cards name, in the settings' order. */
export function providerOrder(cards: QuotaCardData[], s: QuotaSettings): string[] {
  const seen = [...new Set(cards.map((c) => c.provider))];
  const known = s.order.filter((p) => seen.includes(p));
  return [...known, ...seen.filter((p) => !known.includes(p))];
}

/** The window will run out or ran out, and has not reset: what `status` words in red. */
function runningOut(w: QuotaWindow, now: Date): boolean {
  if (w.resetsAt && Date.parse(w.resetsAt) <= now.getTime()) return false;
  return !!w.pace && w.pace.stage !== "unknown" && !w.pace.willLastToReset;
}

/**
 * The cards to show (SPEC.md, "Quota order"): hidden providers out, the rest by provider in the
 * settings' order, each provider's windows in the uploader's order. With `runningOutFirst`,
 * windows that will run out or ran out, and have not reset, lead in that same order.
 */
export function arrange(
  cards: QuotaCardData[],
  s: QuotaSettings,
  now = new Date(),
): QuotaCardData[] {
  const rank = new Map(providerOrder(cards, s).map((p, i) => [p, i]));
  const lead = (c: QuotaCardData) => (s.runningOutFirst && runningOut(c.window, now) ? 0 : 1);
  return cards
    .filter((c) => !s.hidden.includes(c.provider))
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        lead(a.c) - lead(b.c) ||
        (rank.get(a.c.provider) ?? 0) - (rank.get(b.c.provider) ?? 0) ||
        a.i - b.i,
    )
    .map(({ c }) => c);
}

/** The alerts this browser shows a notification for: newly raised, of providers it opted in. */
export function toNotify(alerts: QuotaAlert[], s: QuotaSettings): QuotaAlert[] {
  return alerts.filter(
    (a) =>
      a.notify && s.notify.includes(a.provider) && (a.kind === "low" ? s.notifyLow : s.notifyPace),
  );
}

/** A notification's title and body. */
export function alertText(
  a: QuotaAlert,
  label: string,
  now = new Date(),
): { title: string; body: string } {
  const name = `${a.provider} ${label}`;
  switch (a.kind) {
    case "low":
      return {
        title: `${name}: ${a.threshold}% left`,
        body: `Resets ${relative(a.resetsAt, now)}.`,
      };
    case "runs-out":
      return {
        title: `${name} will run out`,
        body: `Runs out ${relative(a.runsOutAt, now)} at this pace; resets ${relative(a.resetsAt, now)}.`,
      };
    case "unused-headroom":
      return {
        title: `${name} resets with headroom unused`,
        body: `Resets ${relative(a.resetsAt, now)} with ${Math.round(a.unusedPercent)}% unused.`,
      };
  }
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** CodexBar's absolute reset: "14:30" today, "tomorrow 14:30", else "Oct 7, 22:00". */
export function clock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = clockTime(d);
  if (sameDay(d, now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** A reset time in the chosen style: "in 2 h", "2 h ago", or a clock time. */
export function resetTime(iso: string, s: QuotaSettings, now = new Date()): string {
  return s.absoluteResets ? clock(iso, now) : relative(iso, now);
}

const WEEK = 10080;

/**
 * Where an even pace over workdays only would be now, in percent used, as CodexBar's
 * `UsagePace.weekly`: the week splits at local midnights, and Monday to the `workDays`-th day
 * count. Null when it does not apply: no setting, 7 days, or not a weekly window.
 */
export function workdayExpected(
  w: Pick<QuotaWindow, "windowMinutes" | "resetsAt">,
  workDays: number | null,
  now = new Date(),
): number | null {
  if (!workDays || workDays >= 7 || w.windowMinutes !== WEEK || !w.resetsAt) return null;
  const end = Date.parse(w.resetsAt);
  let cursor = end - WEEK * 60_000;
  let total = 0;
  let elapsed = 0;
  const t = now.getTime();
  while (cursor < end) {
    const day = new Date(cursor);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const sliceEnd = Math.min(next, end);
    const iso = day.getDay() === 0 ? 7 : day.getDay();
    if (iso <= workDays) {
      total += sliceEnd - cursor;
      if (t > cursor) elapsed += Math.min(t, sliceEnd) - cursor;
    }
    cursor = sliceEnd;
  }
  return total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : null;
}

/** CodexBar's workday ticks: one per workday boundary, evenly spaced along a weekly bar. */
export function workdayTicks(w: Pick<QuotaWindow, "windowMinutes">, s: QuotaSettings): number[] {
  if (!s.workDays || s.ticks === "hidden" || w.windowMinutes !== WEEK) return [];
  return Array.from({ length: s.workDays - 1 }, (_, i) => ((i + 1) * 100) / (s.workDays as number));
}

/** What a card's bar shows under the settings: its percentage, fill and pace marker. */
export function bar(w: QuotaWindow, s: QuotaSettings, now = new Date()) {
  const used = Math.min(Math.max(Math.round(w.usedPercent), 0), 100);
  const steady = workdayExpected(w, s.workDays, now) ?? w.pace?.expectedUsedPercent ?? null;
  const mark = steady === null ? null : Math.round(steady);
  return {
    percent: s.showUsed ? used : 100 - used,
    word: s.showUsed ? "used" : "left",
    /** Where an even pace would put the bar now, on the same scale as `percent`. */
    steady: mark === null ? null : s.showUsed ? mark : 100 - mark,
    ticks: workdayTicks(w, s),
  };
}

const SHOWN = "starbridge:quota-notified";

/**
 * Shows a normal notification for each alert this browser opted in to that it has not shown
 * yet. Quota snapshots skip Web Push (PROTOCOL.md, "Push"), so the page does it while open.
 */
export async function notifyAlerts(cards: QuotaCardData[], s: QuotaSettings): Promise<void> {
  if (s.notify.length === 0 || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  let shown: string[];
  try {
    shown = JSON.parse(localStorage.getItem(SHOWN) ?? "[]") as string[];
  } catch {
    shown = [];
  }
  const fresh = cards.flatMap((c) =>
    toNotify(c.alerts, s)
      .map((a) => ({ a, c, key: `${c.snapshot}/${a.provider}/${a.window}/${a.kind}` }))
      .filter(({ key }) => !shown.includes(key)),
  );
  if (fresh.length === 0) return;
  try {
    localStorage.setItem(SHOWN, JSON.stringify([...shown, ...fresh.map((f) => f.key)].slice(-200)));
  } catch {}
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const { a, c } of fresh) {
    const { title, body } = alertText(a, c.window.label);
    // One tag per window and kind: a second tab showing it too replaces, not repeats, it.
    const tag = `q:${a.provider}/${a.window}/${a.kind}`;
    if (reg) await reg.showNotification(title, { body, tag });
    else new Notification(title, { body, tag });
  }
}
