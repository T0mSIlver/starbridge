// Snoozing a question (#571): the owner's "not now, show me this again at T". Times resolve on
// this device, in its zone, and travel as absolute times. Pure, so the presets have tests.
import { clockTime } from "./format";
import type { Prefs } from "./prefs";
import type { InboxItem } from "./types";

/** The latest a snooze may run: an unanswered question drops 30 days after it came. */
export const SNOOZE_MAX_MS = 7 * 24 * 60 * 60_000;

/** "This evening" is 18:00, offered until 17:00; "Tomorrow morning" is 9:00. */
const EVENING = 18;
const EVENING_UNTIL = 17;
const MORNING = 9;
/** Before this hour, "Tomorrow morning" is this morning: at 1:00 the owner means in 8 hours. */
const NIGHT_ENDS = 5;

export type SnoozePreset = { label: string; until: Date };

const at = (day: Date, hour: number, plusDays = 0) => {
  const d = new Date(day);
  d.setDate(d.getDate() + plusDays);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/** 1 hour, This evening (until 17:00), Tomorrow morning: the menu's fixed times. */
export function snoozePresets(now: Date): SnoozePreset[] {
  const hour = now.getHours();
  return [
    { label: "1 hour", until: new Date(now.getTime() + 60 * 60_000) },
    ...(hour < EVENING_UNTIL ? [{ label: "This evening", until: at(now, EVENING) }] : []),
    { label: "Tomorrow morning", until: at(now, MORNING, hour < NIGHT_ENDS ? 0 : 1) },
  ];
}

/** Whether `until` is a time a snooze may take: after now, at most 7 days ahead. */
export function snoozeAllowed(until: Date, now: Date): boolean {
  const ms = until.getTime() - now.getTime();
  return ms > 0 && ms <= SNOOZE_MAX_MS;
}

/** Whether the owner has put the item off and its time has not come. */
export function isSnoozed(item: InboxItem, now: number): boolean {
  return item.snoozedUntil !== undefined && Date.parse(item.snoozedUntil) > now;
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/**
 * "18:00", "tomorrow 09:00", "Fri 09:00": when a snooze ends, short enough for a time slot.
 * `named` leaves out "tomorrow" for the menu, whose "Tomorrow morning" says it already.
 */
export function snoozeTime(until: Date, now: Date, clock?: Prefs["clock"], named = false): string {
  const time = clockTime(until, clock);
  if (sameDay(until, now)) return time;
  if (sameDay(until, at(now, 0, 1))) return named ? time : `tomorrow ${time}`;
  const day = until.toLocaleDateString(undefined, {
    weekday: "short",
    // A week ahead is the same weekday as today: the date tells them apart.
    ...(until.getTime() - now.getTime() > 6 * 24 * 60 * 60_000
      ? { day: "numeric", month: "short" }
      : {}),
  });
  return `${day} ${time}`;
}

/** Pick a time's days: today and the 7 after it, each at midnight in this device's zone. */
export function pickDays(now: Date): Date[] {
  return Array.from({ length: 8 }, (_, i) => at(now, 0, i));
}

/** "Today", "Tomorrow", "Thu 8": a day on Pick a time's chips. */
export function dayLabel(day: Date, now: Date): string {
  if (sameDay(day, now)) return "Today";
  if (sameDay(day, at(now, 0, 1))) return "Tomorrow";
  return day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

/** Every half hour of `day` that a snooze may take: after now, at most 7 days ahead. */
export function pickTimes(day: Date, now: Date): Date[] {
  return Array.from({ length: 48 }, (_, i) => {
    const d = new Date(day);
    d.setHours(Math.floor(i / 2), (i % 2) * 30, 0, 0);
    return d;
  }).filter((d) => snoozeAllowed(d, now));
}
