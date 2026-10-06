import { expect, test } from "bun:test";
import {
  arrange,
  bar,
  DEFAULT_SETTINGS,
  groups,
  type QuotaSettings,
  reorder,
  runsOutSoonest,
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

// The same cases as Android's QuotaSettingsTest.arrange* (SPEC.md, "Quota order"). Wednesday noon.
const now = new Date(2026, 9, 7, 12);
const win = (
  provider: string,
  label: string,
  pace: "even" | "unused" | "runs-out" | "ran-out",
  resetsAt = local(12),
): QuotaCardData => {
  const runsOutAt = pace === "runs-out" ? local(8) : pace === "ran-out" ? local(7, 9) : null;
  const unused: QuotaAlert = {
    kind: "unused-headroom",
    provider,
    window: label,
    resetsAt,
    unusedPercent: 40,
  };
  return {
    provider,
    window: {
      ...week(30),
      label,
      resetsAt,
      pace: {
        ...(week(30).pace as NonNullable<QuotaWindow["pace"]>),
        willLastToReset: runsOutAt === null,
        runsOutAt,
      },
    },
    alerts: pace === "unused" ? [unused] : [],
    ...(pace === "unused" ? { alert: unused } : {}),
    snapshot: "q_1",
  };
};
// In the uploader's order: claude's two windows apart, a headroom alert, one that will run out,
// one that ran out, one that ran out and has since reset.
const windows = [
  win("claude", "5-hour", "even"),
  win("zai", "5-hour", "unused"),
  win("codex", "Weekly", "runs-out"),
  win("claude", "Weekly", "ran-out"),
  win("gemini", "Daily", "ran-out", local(7, 10)),
  win("mistral", "Monthly", "even"),
];
const arranged = (s: Partial<QuotaSettings>) =>
  arrange(windows, settings({ hidden: ["mistral"], ...s }), now).map(
    (c) => `${c.provider} ${c.window.label}`,
  );

test("arrange: running out first, then by provider in the uploader's order", () => {
  expect(arranged({})).toEqual([
    "claude Weekly",
    "codex Weekly",
    "claude 5-hour",
    "zai 5-hour",
    "gemini Daily",
  ]);
});

test("arrange: running out first, then the order set", () => {
  expect(arranged({ order: ["zai", "gemini"] })).toEqual([
    "claude Weekly",
    "codex Weekly",
    "zai 5-hour",
    "gemini Daily",
    "claude 5-hour",
  ]);
});

test("arrange: the order set holds for every window when running out first is off", () => {
  expect(arranged({ order: ["zai", "gemini"], runningOutFirst: false })).toEqual([
    "zai 5-hour",
    "gemini Daily",
    "claude 5-hour",
    "claude Weekly",
    "codex Weekly",
  ]);
});

test("groups: one per provider, in the order of its first window", () => {
  const g = groups(arrange(windows, settings({ hidden: ["mistral"] }), now));
  expect(g.map((x) => `${x.provider}: ${x.cards.map((c) => c.window.label).join(", ")}`)).toEqual([
    "claude: Weekly, 5-hour",
    "codex: Weekly",
    "zai: 5-hour",
    "gemini: Daily",
  ]);
});

test("reorder: the dragged providers swap among their own places; hidden and leading ones stay", () => {
  // claude leads (running out) and zai is hidden; the owner drags mistral above codex.
  const order = ["claude", "codex", "zai", "gemini", "mistral"];
  expect(reorder(order, ["mistral", "codex", "gemini"])).toEqual([
    "claude",
    "mistral",
    "zai",
    "codex",
    "gemini",
  ]);
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

test("runsOutSoonest: the leading group whose window runs out first, wherever it sits (#351)", () => {
  const out = (provider: string, at: Date): QuotaCardData => {
    const c = win(provider, "5-hour", "runs-out");
    const pace = c.window.pace as NonNullable<QuotaWindow["pace"]>;
    return { ...c, window: { ...c.window, pace: { ...pace, runsOutAt: at.toISOString() } } };
  };
  const minutes = (m: number) => new Date(now.getTime() + m * 60_000);
  const lead = groups(
    arrange(
      [out("claude", minutes(2880)), out("codex", minutes(34)), out("zai", minutes(2))],
      settings({}),
      now,
    ),
  );
  expect(lead.map((g) => g.provider)).toEqual(["claude", "codex", "zai"]);
  expect(runsOutSoonest(lead, now)?.provider).toBe("zai");
  expect(runsOutSoonest([], now)).toBeUndefined();
  const unknown = win("codex", "Weekly", "runs-out");
  const pace = unknown.window.pace as NonNullable<QuotaWindow["pace"]>;
  const noTime = { ...unknown, window: { ...unknown.window, pace: { ...pace, runsOutAt: null } } };
  expect(runsOutSoonest(groups([noTime]), now)).toBeUndefined();
});
