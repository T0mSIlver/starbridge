import type { PageState } from "./bridge";

/**
 * The Dock icon's badge (#1602): the Needs-you count, as the widget shows it, and none at 0 or
 * signed out. macOS draws the number as it is, and its Badges setting for the app decides whether
 * it shows. Null while the page loads, which keeps the last one.
 */
export function badgeText(state: PageState): string | null {
  if (state.account === "loading") return null;
  if (state.account === "signedOut" || state.count === 0) return "";
  return String(state.count);
}

/**
 * The count the menu bar icon shows: the page's, except while it loads, which keeps the last one
 * (the page sends 0 while a failing server or broken chain re-boots).
 */
export function trayCount(state: PageState, last: number): number {
  return state.account === "loading" ? last : state.count;
}
