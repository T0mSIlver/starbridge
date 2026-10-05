// The rail's Find box: one query the inbox filters by, shared without a context.
import { useSyncExternalStore } from "react";

let query = "";
const listeners = new Set<() => void>();

export function setFind(q: string): void {
  query = q;
  for (const l of listeners) l();
}

export function useFind(): string {
  return useSyncExternalStore(
    (change) => {
      listeners.add(change);
      return () => listeners.delete(change);
    },
    () => query,
    () => "",
  );
}

/** Whether every word of the query appears in one of the texts, ignoring case. */
export function matches(q: string, texts: (string | undefined)[]): boolean {
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}
