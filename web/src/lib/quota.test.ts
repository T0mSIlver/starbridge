import { expect, test } from "bun:test";
import { status } from "./quota";
import type { QuotaWindow } from "./types";

const now = new Date("2026-10-05T10:00:00Z");
const window = (
  pace: Partial<NonNullable<QuotaWindow["pace"]>>,
  resetsAt = "2026-10-10T20:00:00Z",
) =>
  ({
    id: "secondary",
    label: "Weekly",
    usedPercent: 100,
    resetsAt,
    pace: {
      stage: "ahead",
      expectedUsedPercent: 23,
      deltaPercent: 77,
      projectedUsedPercent: null,
      willLastToReset: false,
      runsOutAt: null,
      ...pace,
    },
  }) as QuotaWindow;

test("a run-out time that passed reads Ran out, not a run-out in the past", () => {
  const s = status(
    window({ runsOutAt: "2026-10-05T09:56:00Z" }),
    {
      kind: "runs-out",
      provider: "codex",
      window: "secondary",
      runsOutAt: "2026-10-05T09:56:00Z",
      resetsAt: "2026-10-10T20:00:00Z",
    },
    now,
  );
  expect(s).toMatchObject({
    state: "out",
    word: "Ran out",
    detail: "Back at the reset, in 5 days.",
  });
});

test("a window whose reset passed is over until the next upload", () => {
  const s = status(
    window({ runsOutAt: "2026-10-05T09:00:00Z" }, "2026-10-05T09:30:00Z"),
    undefined,
    now,
  );
  expect(s).toEqual({
    state: "unknown",
    word: "Window reset",
    detail: "Ended at 100% used; waiting for the next upload.",
    resets: "Reset 30 min ago",
  });
});

test("a run-out ahead keeps its alert", () => {
  const s = status(
    window({ runsOutAt: "2026-10-05T10:46:00Z" }),
    {
      kind: "runs-out",
      provider: "codex",
      window: "secondary",
      runsOutAt: "2026-10-05T10:46:00Z",
      resetsAt: "2026-10-10T20:00:00Z",
    },
    now,
  );
  expect(s).toMatchObject({
    word: "Will run out",
    detail: "Runs out in 46 min at this pace; resets in 5 days.",
  });
});
