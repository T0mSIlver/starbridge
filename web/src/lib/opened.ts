// The item a phone or narrow window shows in place of the inbox's list, kept in the address as
// `?item=<id>` on a history entry of its own: Back closes it, a reload keeps it open and a link
// opens it (#347). Wide windows show the item beside the list and push no entry.
import { useSyncExternalStore } from "react";

const PARAM = "item";
const listeners = new Set<() => void>();

function subscribe(change: () => void): () => void {
  listeners.add(change);
  window.addEventListener("popstate", change);
  return () => {
    listeners.delete(change);
    window.removeEventListener("popstate", change);
  };
}

function inAddress(): string | undefined {
  return new URLSearchParams(location.search).get(PARAM) || undefined;
}

function address(id: string | undefined): string {
  const q = new URLSearchParams(location.search);
  if (id === undefined) q.delete(PARAM);
  else q.set(PARAM, id);
  const query = q.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

function changed() {
  for (const l of listeners) l();
}

/** The item open in place of the list, if any. */
export function useOpened(): string | undefined {
  return useSyncExternalStore(subscribe, inAddress, () => undefined);
}

/** Opens `id` on a new history entry, which Back leaves. */
export function openItem(id: string) {
  if (inAddress() === id) return;
  // Next.js copies its own keys beside this one; the mark tells `closeItem` this entry is ours.
  history.pushState({ item: id }, "", address(id));
  changed();
}

const ours = (id: string) => (history.state as { item?: string } | null)?.item === id;

/**
 * Gives an item a link or a cold start opened the list's entry behind it, so Back returns to
 * the list instead of leaving the app.
 */
export function stackItem() {
  const id = inAddress();
  if (id === undefined || ours(id)) return;
  history.replaceState({ item: undefined }, "", address(undefined));
  history.pushState({ item: id }, "", address(id));
}

// Set from `history.back()` until its popstate, so a second tap does not step back twice.
let leaving = false;

/** Back to the list: a step back through history when the entry is ours, else in place. */
export function closeItem() {
  const id = inAddress();
  if (id === undefined || leaving) return;
  if (ours(id)) {
    leaving = true;
    addEventListener("popstate", () => (leaving = false), { once: true });
    history.back();
    return;
  }
  // Without Next.js's keys, its patched replaceState copies them and updates its router too.
  history.replaceState({ item: undefined }, "", address(undefined));
  changed();
}
