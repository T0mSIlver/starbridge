// What this device remembers of the page's views: the inbox's grouping, History open or
// closed, the theme. In localStorage, so the server learns nothing of them.
import { useCallback, useSyncExternalStore } from "react";

export type Prefs = {
  /** The inbox in one feed, by machine, or by whether an agent waits (#191). */
  grouping: "none" | "machine" | "waiting";
  historyOpen: boolean;
  theme: "system" | "light" | "dark";
  /** When a question's row carries its answer buttons on narrow screens (#138). */
  rowAnswers: "always" | "waiting" | "never";
  /** 12- or 24-hour times; "system" follows the browser's language (#161). */
  clock: "system" | "12" | "24";
  /** Widths in px of the wide inbox's list and Quota windows panes, once dragged (#173). */
  listWidth: number | null;
  asideWidth: number | null;
  /** A chime for new questions and prompts while a Starbridge page is open (#165). */
  sound: boolean;
};

const DEFAULTS: Prefs = {
  grouping: "none",
  historyOpen: false,
  theme: "system",
  rowAnswers: "always",
  clock: "system",
  listWidth: null,
  asideWidth: null,
  sound: false,
};

import { readStored, stored, writable } from "./stored";
import { PREFS_KEY as KEY } from "./themeScript";

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: Prefs } | undefined;

function read(): Prefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {}
  if (cache && cache.raw === raw) return cache.value;
  const value = { ...DEFAULTS, ...(readStored(KEY, raw) as Partial<Prefs> | null) };
  cache = { raw, value };
  return value;
}

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return read()[key];
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  const next = { ...read(), [key]: value };
  let raw: string | null = stored(next);
  try {
    // A newer Starbridge's prefs stay for it; this page keeps the change for itself.
    const old = localStorage.getItem(KEY);
    if (writable(old)) localStorage.setItem(KEY, raw);
    else raw = old;
  } catch {
    // Private windows may refuse storage; the choice then lasts for this page.
  }
  cache = { raw, value: next };
  for (const l of listeners) l();
}

function subscribe(change: () => void) {
  listeners.add(change);
  const onStorage = (e: StorageEvent) => e.key === KEY && change();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(change);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePref<K extends keyof Prefs>(key: K): [Prefs[K], (v: Prefs[K]) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read()[key],
    () => DEFAULTS[key],
  );
  return [value, useCallback((v: Prefs[K]) => setPref(key, v), [key])];
}

/** Sets `data-theme` on <html> for the Colours setting; "system" leaves it to the browser. */
export function applyTheme(theme: Prefs["theme"]): void {
  const html = document.documentElement;
  // Off for a frame, so every colour switches at once instead of each fading on its own.
  html.classList.add("no-motion");
  if (theme === "system") html.removeAttribute("data-theme");
  else html.dataset.theme = theme;
  requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove("no-motion")));
}
