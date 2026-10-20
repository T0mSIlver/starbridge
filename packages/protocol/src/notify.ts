// What a push about one question does to its notification, whatever order pushes arrive in and
// however often (#2151). Every client keeps a `Notified` per question across restarts and runs
// each push through `notifyStep`; snooze hiding and the verified answer stay the client's own.
import { laterWaiting } from "./order";

/** What a device remembers of the pushes about one question. */
export type Notified = {
  /** An `answered` or settled push closed it. Unverified, so it only keeps notifications down. */
  closed?: true;
  /** Its notification sounded once. */
  rang?: true;
  /** The last waiting flip applied. */
  waiting?: { at: string; state: "waiting" | "working" };
  /** The `at` of the latest snooze whose return sounded. */
  back?: string;
};

/** A push about the question, as the client opened it. */
export type NotifyEvent =
  | { kind: "decision" }
  | { kind: "answered" }
  | { kind: "waiting"; at: string; state: "waiting" | "working" }
  | { kind: "snooze"; at: string; due: boolean };

/**
 * What the push does: `ring` shows the question with a sound, `quiet` updates it without one,
 * `none` leaves the notifications as they are.
 */
export type NotifyEffect = "ring" | "quiet" | "none";

/** Applies `event` to `kept`: what the device remembers next, and what its notification does. */
export function notifyStep(
  kept: Notified,
  event: NotifyEvent,
): { kept: Notified; effect: NotifyEffect } {
  if (event.kind === "answered") return { kept: { ...kept, closed: true }, effect: "none" };
  if (kept.closed) return { kept, effect: "none" };
  if (event.kind === "decision")
    return kept.rang ? { kept, effect: "none" } : { kept: { ...kept, rang: true }, effect: "ring" };
  if (event.kind === "waiting") {
    const flip = { at: event.at, state: event.state };
    // The same flip again, or one older than the last applied, changes nothing.
    if (!laterWaiting(kept.waiting, flip)) return { kept, effect: "none" };
    const next: Notified = { ...kept, waiting: flip, rang: true };
    // Its first push is a flip: the owner has not heard of the question yet.
    if (!kept.rang) return { kept: next, effect: "ring" };
    const ring = flip.state === "waiting" && kept.waiting?.state !== "waiting";
    return { kept: next, effect: ring ? "ring" : "quiet" };
  }
  // A snooze's first push hides the question, which the client does. Its return rings once, and
  // an older snooze's return, after a newer one's, not at all.
  if (!event.due || (kept.back && !(Date.parse(event.at) > Date.parse(kept.back))))
    return { kept, effect: "none" };
  return { kept: { ...kept, back: event.at, rang: true }, effect: "ring" };
}
