import { expect, test } from "bun:test";
import { needsYou, snoozedEntries } from "./feed";
import { pickDays, pickTimes, snoozePresets, snoozeTime } from "./snooze";
import type { InboxItem } from "./types";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

test("the presets: an hour, this evening until 17:00, then the next morning", () => {
  const names = (now: Date) => snoozePresets(now).map((p) => [p.label, p.until.getTime()]);
  expect(names(at(6, 14, 20))).toEqual([
    ["1 hour", at(6, 15, 20).getTime()],
    ["This evening", at(6, 18).getTime()],
    ["Tomorrow morning", at(7, 9).getTime()],
  ]);
  expect(names(at(6, 17)).map(([l]) => l)).toEqual(["1 hour", "Tomorrow morning"]);
  // In the small hours, "tomorrow morning" is the one about to come.
  expect(names(at(7, 1)).at(-1)).toEqual(["Tomorrow morning", at(7, 9).getTime()]);
});

test("a snooze's end reads as a time today, tomorrow, a weekday, or a date a week out", () => {
  const now = at(6, 14);
  expect(snoozeTime(at(6, 18), now, "24")).toBe("18:00");
  expect(snoozeTime(at(7, 9), now, "24")).toBe("tomorrow 09:00");
  expect(snoozeTime(at(7, 9), now, "24", true)).toBe("09:00");
  expect(snoozeTime(at(9, 9), now, "24")).toMatch(/^Fri 09:00$/);
  expect(snoozeTime(at(13, 9), now, "24")).toMatch(/13/);
});

test("Pick a time offers today and 7 days, each half hour from 5 minutes on, up to 7 days ahead", () => {
  const now = at(6, 14, 27);
  const days = pickDays(now);
  expect(days).toHaveLength(8);
  const today = pickTimes(days[0] as Date, now);
  // 14:30 is 3 minutes out: too soon to tell its push from its return.
  expect(today[0]).toEqual(at(6, 15));
  const last = pickTimes(days[7] as Date, now);
  expect(last.at(-1)).toEqual(at(13, 14));
});

const question = (id: string, extra: Partial<InboxItem> = {}): InboxItem =>
  ({
    decision: { id, createdAt: "2026-10-06T10:00:00Z", source: { machine: "m", project: "p" } },
    machine: { id: "m" },
    ...extra,
  }) as InboxItem;

test("a snoozed question leaves what needs you for Snoozed, the soonest back first, until its time", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const inbox = [
    question("open"),
    question("late", {
      snoozedUntil: "2026-10-07T07:00:00Z",
      waitingSince: "2026-10-06T11:00:00Z",
    }),
    question("soon", { snoozedUntil: "2026-10-06T16:00:00Z" }),
    question("over", { snoozedUntil: "2026-10-06T11:59:00Z" }),
  ];
  expect(needsYou(inbox, [], now).map((e) => e.id)).toEqual(["open", "over"]);
  expect(snoozedEntries(inbox, now).map((e) => e.id)).toEqual(["soon", "late"]);
  expect(needsYou(inbox, [], Date.parse("2026-10-07T08:00:00Z")).map((e) => e.id)).toEqual([
    "late",
    "open",
    "soon",
    "over",
  ]);
});
