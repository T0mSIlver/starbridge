// What this device remembers of the page's views: the inbox's grouping, History open or
// closed, the theme. In localStorage, so the server learns nothing of them.
import { useCallback, useSyncExternalStore } from "react";

export type Prefs = {
  groupByMachine: boolean;
  historyOpen: boolean;
  theme: "system" | "light" | "dark";
};

const DEFAULTS: Prefs = { groupByMachine: false, historyOpen: false, theme: "system" };
const KEY = "starbridge:prefs";
const listeners = new Set<() => void>();
let cache: { raw: string | null; value: Prefs } | undefined;

function read(): Prefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {}
  if (cache && cache.raw === raw) return cache.value;
  let value = DEFAULTS;
  try {
    if (raw) value = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {}
  cache = { raw, value };
  return value;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  const next = { ...read(), [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows may refuse storage; the choice then lasts for this page.
  }
  cache = { raw: JSON.stringify(next), value: next };
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
  if (theme === "system") html.removeAttribute("data-theme");
  else html.dataset.theme = theme;
}

/** Runs before the first paint (layout.tsx), so a forced theme never flashes the other one. */
export const THEME_SCRIPT = `try{var t=JSON.parse(localStorage.getItem("${KEY}")||"{}").theme;if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
