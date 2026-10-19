// Which of two updates of one decision every client keeps, whatever order they arrive in: a push
// and a poll bring them in different orders on different devices (#2103).

/** Milliseconds since the epoch of an ISO time; NaN when it is not one. */
const ms = (at: string) => Date.parse(at);

/**
 * Whether snooze `next` replaces `kept`. The later `at`, compared as instants, wins; on equal
 * instants the earlier `until`, so a question shows rather than hides when two devices snoozed it
 * in the same instant, and two snoozes equal in both mean the same.
 */
export function laterSnooze(
  kept: { at: string; until: string } | undefined,
  next: { at: string; until: string },
): boolean {
  if (!kept) return true;
  const a = ms(kept.at);
  const b = ms(next.at);
  if (a !== b) return b > a;
  return ms(next.until) < ms(kept.until);
}

/**
 * Whether waiting state `next` replaces `kept`: the later `at`, compared as instants; on equal
 * instants `waiting`, which tells the owner the agent is blocked.
 */
export function laterWaiting(
  kept: { at: string; state: "waiting" | "working" } | undefined,
  next: { at: string; state: "waiting" | "working" },
): boolean {
  if (!kept) return true;
  const a = ms(kept.at);
  const b = ms(next.at);
  if (a !== b) return b > a;
  return next.state === "waiting" && kept.state !== "waiting";
}

/**
 * The `at` a device stamps on a snooze it sends at `now`: `now`, or just past `last`, the latest
 * snooze of the decision it knows, when that one is not before `now` (another device's clock runs
 * ahead, or it was stamped ahead). Whole seconds for a client that stamps them, a millisecond past
 * otherwise.
 */
export function snoozeStamp(now: number, last?: string, wholeSeconds = false): string {
  const step = wholeSeconds ? 1000 : 1;
  const floor = (t: number) => Math.floor(t / step) * step;
  const after = last && !Number.isNaN(ms(last)) ? floor(ms(last)) + step : 0;
  const t = Math.max(floor(now), after);
  const iso = new Date(t).toISOString();
  return wholeSeconds ? `${iso.slice(0, 19)}Z` : iso;
}
