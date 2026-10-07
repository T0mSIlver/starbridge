// Snoozing a question (#571): the owner's "not now, show me this again at T". Times resolve on
// this device, in its zone, and travel as absolute times. Pure, so the presets have tests.
import { clockTime } from "./format";
import type { Prefs } from "./prefs";
import type { InboxItem } from "./types";

/** The latest a snooze may run: an unanswered question drops 30 days after it came. */
export const SNOOZE_MAX_MS = 7 * 24 * 60 * 60_000;

/** "This evening" is 18:00, offered until 17:00; another day's time starts at 9:00. */
const EVENING = 18;
const EVENING_UNTIL = 17;
const MORNING = 9;

export type SnoozePreset = { label: string; until: Date };

const at = (day: Date, hour: number, plusDays = 0) => {
  const d = new Date(day);
  d.setDate(d.getDate() + plusDays);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/** 1 hour, then This evening until 17:00: the fixed times above the days (#699). */
export function snoozePresets(now: Date): SnoozePreset[] {
  return [
    { label: "1 hour", until: new Date(now.getTime() + 60 * 60_000) },
    ...(now.getHours() < EVENING_UNTIL ? [{ label: "This evening", until: at(now, EVENING) }] : []),
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

/** "18:00", "tomorrow 09:00", "Fri 09:00": when a snooze ends, short enough for a time slot. */
export function snoozeTime(until: Date, now: Date, clock?: Prefs["clock"]): string {
  const time = clockTime(until, clock);
  if (sameDay(until, now)) return time;
  if (sameDay(until, at(now, 0, 1))) return `tomorrow ${time}`;
  const day = until.toLocaleDateString(undefined, {
    weekday: "short",
    // A week ahead is the same weekday as today: the date tells them apart.
    ...(until.getTime() - now.getTime() > 6 * 24 * 60 * 60_000
      ? { day: "numeric", month: "short" }
      : {}),
  });
  return `${day} ${time}`;
}

/** The days a snooze can end on: today and the 7 after it, each at midnight in this device's zone. */
export function pickDays(now: Date): Date[] {
  return Array.from({ length: 8 }, (_, i) => at(now, 0, i));
}

/** "Today", "Tomorrow", "Thu 8": a day's chip. */
export function dayLabel(day: Date, now: Date): string {
  if (sameDay(day, now)) return "Today";
  if (sameDay(day, at(now, 0, 1))) return "Tomorrow";
  return day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

/** The shortest snooze: a device tells its first push from its return by it (sw.ts). */
export const SNOOZE_MIN_MS = 5 * 60_000;

/** Every half hour of `day` that a snooze may take: 5 minutes from now on, at most 7 days ahead. */
export function pickTimes(day: Date, now: Date): Date[] {
  return Array.from({ length: 48 }, (_, i) => {
    const d = new Date(day);
    d.setHours(Math.floor(i / 2), (i % 2) * 30, 0, 0);
    return d;
  }).filter((d) => snoozeTakes(d, now));
}

/**
 * The time a day's chip starts on (#699, as Android's #692): today an hour ahead, up to the half
 * hour; another day 9:00. Late in the evening, today's last half hour that a snooze may take.
 */
export function snoozeStart(day: Date, now: Date): Date | undefined {
  const times = pickTimes(day, now);
  if (!sameDay(day, now)) return times.find((t) => t.getHours() === MORNING) ?? times[0];
  return times.find((t) => t.getTime() >= now.getTime() + 60 * 60_000) ?? times.at(-1);
}

/** Whether a snooze may end at `until`: 5 minutes from now on, at most 7 days ahead. */
export const snoozeTakes = (until: Date, now: Date) =>
  until.getTime() - now.getTime() >= SNOOZE_MIN_MS && snoozeAllowed(until, now);

/** "15:30", as a time field holds it; empty without a time. */
export const hhmm = (d: Date | undefined) =>
  d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";

/** `day` at a time field's "15:30", in this device's zone. */
export function onDay(day: Date, time: string): Date {
  const [h = 0, m = 0] = time.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}
