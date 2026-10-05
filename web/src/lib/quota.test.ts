import { expect, test } from "bun:test";
import { status } from "./quota";
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

test("a window whose reset passed is over until the next upload", () => {
  expect(status(window({}, "2026-10-05T09:30:00Z"), undefined, rel, now)).toEqual({
    state: "unknown",
    word: "Window reset",
    reset: "",
  });
});

test("a run-out time tomorrow reads without 'at'", () => {
  const s = status(
    window({ runsOutAt: "2026-10-06T07:20:00Z" }, "2026-10-07T12:00:00Z"),
    undefined,
    { absoluteResets: true },
    now,
  );
  expect(s.word).toMatch(/^Will run out tomorrow \d/);
});
