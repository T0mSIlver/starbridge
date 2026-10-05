import { expect, test } from "bun:test";
import { duration, progressText, runState, SHOWN_AFTER_MS, shownRuns } from "./runs";
import type { RunItem } from "./types";

const T0 = Date.parse("2026-10-05T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function item(id: string, over: Partial<RunItem["run"]> = {}): RunItem {
  return {
    machine: "devbox",
    run: {
      v: 1,
      id,
      to: ["phone"],
      title: id,
      reason: "uses your session and keyboard",
      source: { machine: "devbox", project: "p", session: "s" },
      startedAt: at(0),
      at: at(0),
      ...over,
    },
  };
}

test("a run is running until it exits, and lost once its machine goes quiet for 3 minutes", () => {
  expect(runState(item("a").run, T0 + 60_000)).toBe("running");
  expect(runState(item("a").run, T0 + 181_000)).toBe("lost");
  expect(runState(item("a", { exit: { code: 0, at: at(5) } }).run, T0)).toBe("passed");
  expect(runState(item("a", { exit: { code: 2, at: at(5) } }).run, T0)).toBe("failed");
});

test("running runs come first, newest first; finished ones stay half an hour", () => {
  const now = T0 + 60_000;
  const runs = [
    item("old-pass", { exit: { code: 0, at: at(60_000 - SHOWN_AFTER_MS) } }),
    item("gone", { exit: { code: 0, at: at(60_000 - SHOWN_AFTER_MS - 1) } }),
    item("fail", { exit: { code: 1, at: at(30_000) } }),
    item("early", { startedAt: at(-10_000), at: at(50_000) }),
    item("late", { startedAt: at(10_000), at: at(50_000) }),
  ];
  expect(shownRuns(runs, now).map((r) => r.run.id)).toEqual(["late", "early", "fail", "old-pass"]);
});

test("durations and progress read at a glance", () => {
  expect(duration(8_400)).toBe("8 s");
  expect(duration(125_000)).toBe("2 min 05 s");
  expect(duration(3_780_000)).toBe("1 h 03 min");
  expect(progressText({ done: 3, total: 7, unit: "step" })).toBe("3/7");
  expect(progressText({ done: 42, total: 100, unit: "percent" })).toBe("42%");
});
