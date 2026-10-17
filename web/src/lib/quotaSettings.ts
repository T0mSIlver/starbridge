// Quota settings, per browser (spec/items.md, "Quota settings follow CodexBar"): a curated set of
// CodexBar's own settings with CodexBar's meaning. They stay in this browser; the server learns
// nothing of them. Android keeps the same set (QuotaSettings.kt).

import {
  arrangeQuotas,
  DEFAULT_QUOTA_ALERTS,
  type QuotaAlertSettings,
  type QuotaPlace,
  quotaCourse,
  quotaProviders,
  quotaRunningOut,
  wantsQuotaAlert,
} from "@starbridge/protocol";
import { desktop } from "./desktop";
import { clockTime, relative } from "./format";
import { switchedOff } from "./notify";
import { readStored, stored, writable } from "./stored";
import type { QuotaAlert, QuotaCardData, QuotaWindow } from "./types";

export type QuotaSettings = {
  /** The bar and the percentage show used, else remaining (CodexBar `usageBarsShowUsed`). */
  showUsed: boolean;
  /** Reset times as a clock time, else "in 2 h" (`resetTimesShowAbsolute`). */
  absoluteResets: boolean;
  /** Workdays a week on weekly bars: Monday on (`weeklyProgressWorkDays`); null is off. */
  workDays: 4 | 5 | 7 | null;
  /** Providers in the order to show them; the ones not listed follow in the uploader's order. */
  order: string[];
  /** Windows that will run out or ran out lead, else `order` holds for every window. */
  runningOutFirst: boolean;
  hidden: string[];
  /** Which alerts notify, per window (#914). */
  alerts: QuotaAlertSettings;
};

export const DEFAULT_SETTINGS: QuotaSettings = {
  showUsed: true,
  absoluteResets: false,
  workDays: null,
  order: [],
  runningOutFirst: true,
  hidden: [],
  alerts: DEFAULT_QUOTA_ALERTS,
};

/**
 * Settings as stored, from this release or an older one, whose tick style's "Hidden" was ticks
 * off. The bell and switches of releases before #914 are dropped: their alerts are the defaults.
 */
export function readSettings(stored: Record<string, unknown> | null): QuotaSettings {
  const { notify: _, notifyLow: __, notifyPace: ___, ticks, ...rest } = stored ?? {};
  const s = { ...DEFAULT_SETTINGS, ...(rest as Partial<QuotaSettings>) };
  if (ticks === "hidden") s.workDays = null;
  return s;
}

/** Whether any window can notify, so a hidden page keeps reading quotas. */
export const alertsOn = (a: QuotaAlertSettings) =>
  a.short.length > 0 || a.long.length > 0 || Object.values(a.windows).some((c) => c.length > 0);

const KEY = "starbridge:quota-settings";

export function loadSettings(): QuotaSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return readSettings(readStored(KEY, raw) as Record<string, unknown> | null);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: QuotaSettings): void {
  try {
    if (writable(localStorage.getItem(KEY))) localStorage.setItem(KEY, stored(s));
  } catch {
    // Private windows may refuse storage; the settings then last for this page.
  }
}

/**
 * Whether the server holds quotas for the account, opened or not (#914): until a machine sends
 * them, the Quotas tab and settings stay out of the way.
 */
export const holdsQuotas = (
  q: { cards: unknown[]; errors: unknown[]; rejected: unknown[] } | undefined,
) => !!q && q.cards.length + q.errors.length + q.rejected.length > 0;

const SENDS = "starbridge:quota-account";

/**
 * Whether `account` held quotas when this browser last read them, so a page load shows the Quotas
 * tab from its first frame rather than once they arrive (#1805).
 */
export function heldQuotas(account: string | undefined): boolean {
  if (!account) return false;
  try {
    return readStored(SENDS, localStorage.getItem(SENDS))?.account === account;
  } catch {
    return false;
  }
}

export function keepHeldQuotas(account: string, held: boolean): void {
  try {
    if (!writable(localStorage.getItem(SENDS))) return;
    if (held) localStorage.setItem(SENDS, stored({ account }));
    else if (heldQuotas(account)) localStorage.removeItem(SENDS);
  } catch {}
}

/** Every provider the cards name, in the settings' order. */
export function providerOrder(cards: QuotaCardData[], s: QuotaSettings): string[] {
  return quotaProviders(
    cards.map((c) => c.provider),
    s,
  );
}

/**
 * `order` (every provider) after the owner dragged some of them into `sequence`: those take the
 * places they held, in their new order, and every other provider keeps its place.
 */
export function reorder(order: string[], sequence: string[]): string[] {
  const moved = new Set(sequence);
  let next = 0;
  return order.map((p) => (moved.has(p) ? (sequence[next++] ?? p) : p));
}

/** A window as packages/protocol places and words it; `unused` when its card's alert says so. */
export function place(w: QuotaWindow, unused = false): QuotaPlace {
  return {
    course: quotaCourse(w.pace, unused),
    runsOutAt: w.pace?.runsOutAt ?? null,
    resetsAt: w.resetsAt,
  };
}

/** The window will run out or ran out, and has not reset: what `status` words in red. */
export function runningOut(w: QuotaWindow, now: Date): boolean {
  return quotaRunningOut(place(w), now);
}

/**
 * The cards to show (spec/items.md, "Quota order"): hidden providers out, the rest by provider in the
 * settings' order, a provider's machines by name (the server's order is by machine id, which differs
 * between accounts), each machine's windows in the uploader's order. With `runningOutFirst`,
 * windows that will run out or ran out, and have not reset, lead in that same order.
 */
export function arrange(
  cards: QuotaCardData[],
  s: QuotaSettings,
  now = new Date(),
): QuotaCardData[] {
  return arrangeQuotas(cards, s, (c) => ({
    provider: c.provider,
    machine: c.machine,
    runningOut: runningOut(c.window, now),
  }));
}

export type QuotaGroup = {
  provider: string;
  machine?: string;
  cards: QuotaCardData[];
  /** Why CodexBar failed for the provider; `updatedAt` is when its kept windows were read. */
  stale?: { updatedAt?: string; error: string };
};

/**
 * Arranged cards under one heading per provider and machine (#160): groups in the order their
 * first window comes, so a provider with a window running out leads, and windows keep their order.
 */
export function groups(arranged: QuotaCardData[]): QuotaGroup[] {
  const byKey = new Map<string, QuotaGroup>();
  for (const c of arranged) {
    const key = `${c.provider}\n${c.machine ?? ""}`;
    const g = byKey.get(key);
    if (g) g.cards.push(c);
    else
      byKey.set(key, {
        provider: c.provider,
        machine: c.machine,
        cards: [c],
        ...(c.stale ? { stale: c.stale } : {}),
      });
  }
  return [...byKey.values()];
}

/**
 * Of the groups that lead while "Running out first" is on, the one with the window that runs out
 * soonest (#351): they lead in the provider order, so it need not be the first.
 */
export function runsOutSoonest(lead: QuotaGroup[], now: Date): QuotaGroup | undefined {
  const at = (g: QuotaGroup) =>
    Math.min(
      ...g.cards
        .filter((c) => runningOut(c.window, now))
        .map((c) => Date.parse(c.window.pace?.runsOutAt ?? "") || Infinity),
    );
  // None when no leading window says when it runs out.
  return lead.reduce<QuotaGroup | undefined>(
    (best, g) => (at(g) < (best ? at(best) : Infinity) ? g : best),
    undefined,
  );
}

/** The alerts this browser shows a notification for: newly raised, and picked for the window. */
export function toNotify(
  alerts: QuotaAlert[],
  s: QuotaSettings,
  windowMinutes: number | null,
): QuotaAlert[] {
  return alerts.filter((a) => a.notify && wantsQuotaAlert(s.alerts, a, windowMinutes));
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

/**
 * A clock time in a sentence: "at 15:55" today, "tomorrow at 10:15", "yesterday at 10:15", else
 * "on Oct 8 at 10:15".
 */
export function clockAt(iso: string, now = new Date(), hours?: "12" | "24"): string {
  const d = new Date(iso);
  const time = clockTime(d, hours);
  const day = (offset: number) => {
    const x = new Date(now);
    x.setDate(now.getDate() + offset);
    return sameDay(d, x);
  };
  if (day(0)) return `at ${time}`;
  if (day(1)) return `tomorrow at ${time}`;
  if (day(-1)) return `yesterday at ${time}`;
  return `on ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
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
  if (!s.workDays || w.windowMinutes !== WEEK) return [];
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
  if (!alertsOn(s.alerts) || typeof Notification === "undefined") return;
  // This device's switch is off (#943): the browser still grants the permission.
  if (switchedOff()) return;
  if (Notification.permission !== "granted") return;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SHOWN);
  } catch {}
  // A newer Starbridge keeps that list: it notifies, so this page does not repeat it each poll.
  if (!writable(raw)) return;
  const kept = readStored(SHOWN, raw)?.shown;
  const shown = Array.isArray(kept) ? (kept as string[]) : [];
  const fresh = cards.flatMap((c) =>
    toNotify(c.alerts, s, c.window.windowMinutes)
      .map((a) => ({ a, c, key: `${c.snapshot}/${a.provider}/${a.window}/${a.kind}` }))
      .filter(({ key }) => !shown.includes(key)),
  );
  if (fresh.length === 0) return;
  try {
    localStorage.setItem(
      SHOWN,
      stored({ shown: [...shown, ...fresh.map((f) => f.key)].slice(-200) }),
    );
  } catch {}
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const { a, c } of fresh) {
    const { title, body } = alertText(a, c.window.label);
    // One tag per window and kind: a second tab showing it too replaces, not repeats, it.
    const tag = `q:${a.provider}/${a.window}/${a.kind}`;
    // Silent in the desktop app, whose questions and prompts sound (#1055).
    const opts = { body, tag, silent: !!desktop };
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  }
}
