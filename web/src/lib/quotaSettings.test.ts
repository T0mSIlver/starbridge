import { expect, test } from "bun:test";
import {
  arrange,
  bar,
  DEFAULT_SETTINGS,
  type QuotaSettings,
  toNotify,
  workdayExpected,
} from "./quotaSettings";
import type { QuotaAlert, QuotaCardData, QuotaWindow } from "./types";

// Local times, so the week splits at this machine's midnights as it would in the browser.
const local = (d: number, h = 0) => new Date(2026, 9, d, h).toISOString();
const week = (usedPercent: number): QuotaWindow => ({
  id: "secondary",
  label: "Weekly",
  usedPercent,
  windowMinutes: 10080,
  // Monday 12 October at midnight: the week ran from Monday 5 October.
  resetsAt: local(12),
  pace: {
    stage: "on-track",
    expectedUsedPercent: 28.6,
    deltaPercent: 0,
    projectedUsedPercent: 100,
    willLastToReset: true,
    runsOutAt: null,
  },
});
const settings = (s: Partial<QuotaSettings>): QuotaSettings => ({ ...DEFAULT_SETTINGS, ...s });

test("workdays: the pace marker counts Monday to Friday only, as CodexBar does", () => {
  // Wednesday midnight: 2 of 5 workdays passed, where the plain week is 2 of 7.
  expect(workdayExpected(week(0), 5, new Date(local(7)))).toBeCloseTo(40);
  expect(workdayExpected(week(0), 4, new Date(local(10, 12)))).toBe(100);
  expect(workdayExpected(week(0), 7, new Date(local(7)))).toBeNull();
  expect(workdayExpected({ ...week(0), windowMinutes: 300 }, 5, new Date(local(7)))).toBeNull();
});

test("bar: used or remaining, with ticks and the marker on the same scale", () => {
  const now = new Date(local(7));
  expect(bar(week(30), DEFAULT_SETTINGS, now)).toEqual({
    percent: 30,
    word: "used",
    steady: 29,
    ticks: [],
  });
  expect(bar(week(30), settings({ showUsed: false, workDays: 5 }), now)).toEqual({
    percent: 70,
    word: "left",
    steady: 60,
    ticks: [20, 40, 60, 80],
  });
  expect(bar(week(30), settings({ workDays: 5, ticks: "hidden" }), now).ticks).toEqual([]);
});

const card = (provider: string, alerts: QuotaAlert[] = []): QuotaCardData => ({
  provider,
  window: week(30),
  alerts,
  ...(alerts[0] ? { alert: alerts[0] } : {}),
  snapshot: "q_1",
});

test("arrange: hidden providers out, the owner's order, else alerts first", () => {
  const unused: QuotaAlert = {
    kind: "unused-headroom",
    provider: "zai",
    window: "secondary",
    resetsAt: local(12),
    unusedPercent: 40,
  };
  const cards = [card("claude"), card("zai", [unused]), card("codex")];
  const names = (s: QuotaSettings) => arrange(cards, s).map((c) => c.provider);
  expect(names(DEFAULT_SETTINGS)).toEqual(["zai", "claude", "codex"]);
  expect(names(settings({ order: ["codex"], hidden: ["claude"] }))).toEqual(["codex", "zai"]);
});

test("notifications: only new alerts, of providers this device opted in to, of chosen kinds", () => {
  const base = { window: "primary", resetsAt: local(12) };
  const alerts: QuotaAlert[] = [
    { kind: "low", provider: "zai", threshold: 20, notify: true, ...base },
    { kind: "runs-out", provider: "zai", runsOutAt: local(11), notify: true, ...base },
    { kind: "low", provider: "claude", threshold: 50, notify: true, ...base },
    { kind: "low", provider: "zai", threshold: 50, ...base },
  ];
  const kinds = (s: QuotaSettings) => toNotify(alerts, s).map((a) => `${a.provider} ${a.kind}`);
  expect(kinds(DEFAULT_SETTINGS)).toEqual([]);
  expect(kinds(settings({ notify: ["zai"] }))).toEqual(["zai low", "zai runs-out"]);
  expect(kinds(settings({ notify: ["zai"], notifyLow: false }))).toEqual(["zai runs-out"]);
});
