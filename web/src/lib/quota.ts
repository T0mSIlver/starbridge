// A quota window's state and words, as on Android (QuotasScreen.kt): a window whose reset
// passed is over until the next upload, and a run-out time that passed reads "Ran out".
import { relative } from "./format";
import type { QuotaAlert, QuotaWindow } from "./types";

/** The CSS class of the state's colour; "unknown" is grey. */
export type State = "ok" | "unused" | "out" | "unknown";

export type Status = { state: State; word: string; detail?: string; resets: string };

/** `at` writes a time: relative ("in 2 h") by default, or a clock time (quotaSettings.ts). */
export function status(
  w: QuotaWindow,
  alert: QuotaAlert | undefined,
  now = new Date(),
  at: (iso: string) => string = (iso) => relative(iso, now),
): Status {
  if (w.resetsAt && Date.parse(w.resetsAt) <= now.getTime())
    return {
      state: "unknown",
      word: "Window reset",
      detail: `Ended at ${Math.round(w.usedPercent)}% used; waiting for the next upload.`,
      resets: `Reset ${at(w.resetsAt)}`,
    };
  const resets = w.resetsAt ? `Resets ${at(w.resetsAt)}` : "Reset time unknown";
  if (!w.pace || w.pace.stage === "unknown")
    return { state: "unknown", word: "Too early to tell", resets };
  if (!w.pace.willLastToReset) {
    const ranOut =
      w.pace.runsOutAt !== undefined &&
      w.pace.runsOutAt !== null &&
      Date.parse(w.pace.runsOutAt) <= now.getTime();
    if (ranOut)
      return {
        state: "out",
        word: "Ran out",
        detail: w.resetsAt ? `Back at the reset, ${at(w.resetsAt)}.` : "Back at the reset.",
        resets,
      };
    return {
      state: "out",
      word: "Will run out",
      detail: alert?.kind === "runs-out" ? runsOut(alert, at) : undefined,
      resets,
    };
  }
  if (alert?.kind === "unused-headroom")
    return {
      state: "unused",
      word: "Headroom unused",
      detail: `Resets ${at(alert.resetsAt)} with ${Math.round(alert.unusedPercent)}% unused.`,
      resets,
    };
  return { state: "ok", word: "On pace", resets };
}

function runsOut(
  a: Extract<QuotaAlert, { kind: "runs-out" }>,
  at: (iso: string) => string,
): string {
  return `Runs out ${at(a.runsOutAt)} at this pace; resets ${at(a.resetsAt)}.`;
}
