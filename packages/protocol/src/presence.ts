import { z } from "zod";

/**
 * Presence (#848): whether the owner sits at an unlocked screen they used in the last minute. A
 * machine reads its own lock and idle state, a device its page or app in front and touched; each
 * reduces that to one bit where it is read and sends only the bit. While any source of an
 * account is present, the server holds the pushes of new questions and permission prompts for
 * the account's hold time, then pushes those still open.
 */

/** Input this recent makes a screen present. */
export const PRESENCE_INPUT_MS = 60_000;
/** A present source says so again this often. */
export const PRESENCE_BEAT_MS = 30_000;
/** The server counts a source present this long after its last beat. */
export const PRESENCE_VALID_MS = 75_000;

/** `PUT /presence`: one bit, from a machine or a device. */
export const Presence = z.object({ present: z.boolean() });
export type Presence = z.infer<typeof Presence>;

/** The hold times clients offer, in seconds; 0 pushes at once, as without presence. */
export const PUSH_HOLD_CHOICES = [0, 15, 30, 60, 120] as const;
export const PUSH_HOLD_DEFAULT = 30;
export const PUSH_HOLD_MAX = 300;

/** `GET` and `PUT /settings`: the account's own settings, which the server applies. */
export const AccountSettings = z.object({
  /** Seconds a push waits while the owner is present. */
  pushHold: z.number().int().min(0).max(PUSH_HOLD_MAX),
});
export type AccountSettings = z.infer<typeof AccountSettings>;

/** Whether a screen counts as present: unlocked, with input in the last minute. */
export function isPresent(screen: { locked: boolean; idleMs: number }): boolean {
  return !screen.locked && screen.idleMs >= 0 && screen.idleMs < PRESENCE_INPUT_MS;
}
