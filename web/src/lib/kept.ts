// The inbox's items as the server listed them, still sealed, so that a page load reads only what
// came after them (#1380). Each load opens them again: nothing opened is kept.
import type { Stored } from "./api";

/** What this browser keeps of an account's inbox, for the device that can open it. */
export interface Kept {
  device: string;
  cursor: string;
  items: Stored[];
}

/** Answered decisions kept, the latest, as the Android and iPhone apps keep 500. */
export const KEPT_ANSWERED = 500;
/**
 * Notices whose decision is not kept stay this many, the latest: a settled notice can list
 * before the decision it closed.
 */
export const KEPT_LOOSE = 200;

/**
 * `old` with `read` after it, each item once at its latest listing, as the server moves an
 * item past every cursor when it changes. Decisions in `drop` go, and answered ones past the
 * latest `KEPT_ANSWERED`; a waiting state, snooze or settled notice goes with its decision.
 */
export function merge(old: Stored[], read: Stored[], drop: ReadonlySet<string>): Stored[] {
  const byKey = new Map<string, Stored>();
  for (const s of [...old, ...read]) {
    const key = `${s.item.kind}/${s.item.id}`;
    byKey.delete(key);
    byKey.set(key, s);
  }
  const all = [...byKey.values()].filter((s) => s.item.kind !== "decision" || !drop.has(s.item.id));
  const answered = all.filter((s) => s.item.kind === "decision" && s.answeredAt);
  const cut = new Set(
    answered.slice(0, Math.max(0, answered.length - KEPT_ANSWERED)).map((s) => s.item.id),
  );
  const decisions = new Set(
    all.filter((s) => s.item.kind === "decision" && !cut.has(s.item.id)).map((s) => s.item.id),
  );
  return all.filter((s, i) =>
    s.item.kind === "decision"
      ? decisions.has(s.item.id)
      : (s.item.re !== undefined && decisions.has(s.item.re)) || i >= all.length - KEPT_LOOSE,
  );
}
