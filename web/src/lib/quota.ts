// A quota window's state, as words (DESIGN.md, "Rules"): the status word carries the state in
// its colour, and the time it is about. A window whose reset passed is over until the next
// upload, which says when it reset, and a run-out time that passed reads "Ran out".
import { relative } from "./format";
import { clock, clockAt, type QuotaSettings } from "./quotaSettings";
import type { QuotaAlert, QuotaWindow } from "./types";

/** The colour of the word: grey on pace, amber with headroom unused, red when it runs out. */
export type State = "ok" | "unused" | "out" | "ran-out" | "unknown";

export type Status = { state: State; word: string; reset: string };

/** "38 min", "1 h 50 min", "2 d 4 h": how long until `iso`. */
export function span(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
  const d = Math.floor(m / (24 * 60));
  const h = Math.round((m % (24 * 60)) / 60);
  return h && h < 24 ? `${d} d ${h} h` : `${h === 24 ? d + 1 : d} d`;
}

/** "1 h 50 min" or "14:20": when the window resets. */
function when(iso: string, s: Pick<QuotaSettings, "absoluteResets">, now: Date): string {
  return s.absoluteResets ? clock(iso, now) : span(iso, now);
}

export function status(
  w: QuotaWindow,
  alert: QuotaAlert | undefined,
  s: Pick<QuotaSettings, "absoluteResets">,
  now = new Date(),
): Status {
  if (w.resetsAt && Date.parse(w.resetsAt) <= now.getTime())
    return {
      state: "unknown",
      word: "Window reset",
      reset: s.absoluteResets ? clock(w.resetsAt, now) : relative(w.resetsAt, now),
    };
  const reset = w.resetsAt ? when(w.resetsAt, s, now) : "";
  if (!w.pace || w.pace.stage === "unknown")
    return { state: "unknown", word: "Too early to tell", reset };
  if (!w.pace.willLastToReset) {
    const at = w.pace.runsOutAt;
    if (at && Date.parse(at) <= now.getTime())
      return { state: "ran-out", word: `Ran out ${clockAt(at, now)}`, reset };
    if (!at) return { state: "out", word: "Will run out", reset };
    // "in 50 min", or "at 14:20", "tomorrow at 07:20", "on Oct 8 at 10:15".
    const by = s.absoluteResets ? clockAt(at, now) : relative(at, now);
    return { state: "out", word: `Will run out ${by}`, reset };
  }
  if (alert?.kind === "unused-headroom") return { state: "unused", word: "Headroom unused", reset };
  return { state: "ok", word: "On pace", reset };
}
