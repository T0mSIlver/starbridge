// Whether the keyboard shortcuts dialog is open: opened by the `?` key (Shell) and by Settings' row.
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

export function setShortcuts(value: boolean): void {
  open = value;
  for (const l of listeners) l();
}

export function useShortcuts(): boolean {
  return useSyncExternalStore(
    (change) => {
      listeners.add(change);
      return () => listeners.delete(change);
    },
    () => open,
    () => false,
  );
}
