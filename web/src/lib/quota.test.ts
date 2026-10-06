import { expect, test } from "bun:test";
import { status } from "./quota";
import { clockAt } from "./quotaSettings";
import type { QuotaWindow } from "./types";

const now = new Date("2026-10-05T10:00:00Z");
const rel = { absoluteResets: false };
const window = (
  pace: Partial<NonNullable<QuotaWindow["pace"]>>,
  resetsAt = "2026-10-05T12:00:00Z",
) =>
  ({
    id: "primary",
    label: "5-hour",
    usedPercent: 81,
    resetsAt,
    pace: {
      stage: "ahead",
      expectedUsedPercent: 63,
      deltaPercent: 18,
      projectedUsedPercent: null,
      willLastToReset: false,
      runsOutAt: null,
      ...pace,
    },
  }) as QuotaWindow;

test("a window that will run out says when, and its reset without 'in'", () => {
  expect(status(window({ runsOutAt: "2026-10-05T10:50:00Z" }), undefined, rel, now)).toEqual({
    state: "out",
    word: "Will run out in 50 min",
    reset: "2 h",
  });
});

test("a run-out time that passed reads Ran out at its clock time", () => {
  const s = status(window({ runsOutAt: "2026-10-05T09:40:00Z" }), undefined, rel, now);
  expect(s.state).toBe("ran-out");
  expect(s.word).toMatch(/^Ran out at \d\d:\d\d/);
});

test("a window whose reset passed is over until the next upload, which says when it reset", () => {
  expect(status(window({}, "2026-10-05T09:30:00Z"), undefined, rel, now)).toEqual({
    state: "unknown",
    word: "Window reset",
    reset: "30 min ago",
  });
  const abs = status(window({}, "2026-10-05T09:30:00Z"), undefined, { absoluteResets: true }, now);
  expect(abs.reset).toMatch(/^\d\d:30/);
});

test("a run-out time tomorrow reads 'tomorrow at'", () => {
  const s = status(
    window({ runsOutAt: "2026-10-06T07:20:00Z" }, "2026-10-07T12:00:00Z"),
    undefined,
    { absoluteResets: true },
    now,
  );
  expect(s.word).toMatch(/^Will run out tomorrow at \d/);
});

test("clockAt: 'at' a time today, 'tomorrow at', 'yesterday at', else 'on' a date 'at'", () => {
  // Local times, so the days follow the machine's zone as the page's do.
  const noon = new Date(2026, 9, 5, 12, 0);
  const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).toISOString();
  expect(clockAt(at(5, 15, 55), noon, "24")).toBe("at 15:55");
  expect(clockAt(at(6, 10, 15), noon, "24")).toBe("tomorrow at 10:15");
  expect(clockAt(at(8, 10, 15), noon, "24")).toMatch(/^on Oct 8 at 10:15$/);
  expect(clockAt(at(4, 22, 5), noon, "24")).toBe("yesterday at 22:05");
  expect(clockAt(at(1, 9, 0), noon, "24")).toMatch(/^on Oct 1 at 09:00$/);
  expect(clockAt(at(5, 15, 55), noon, "12")).toMatch(/^at 03:55\s?PM$/i);
  expect(clockAt(at(8, 10, 15), noon, "12")).toMatch(/^on Oct 8 at 10:15\s?AM$/i);
});
