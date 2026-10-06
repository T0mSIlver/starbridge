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
  // Next.js keeps its own keys beside this one; the mark tells `closeItem` this entry is ours.
  history.pushState({ item: id }, "", address(id));
  changed();
}

/**
 * Back to the list: through history when this page pushed the entry, so Back after it leaves
 * the inbox instead of reopening the item; in place when a link or a reload opened it.
 */
export function closeItem() {
  const id = inAddress();
  if (id !== undefined && (history.state as { item?: string } | null)?.item === id) {
    history.back();
    return;
  }
  forgetItem();
}

/** Drops the item from the address without a history step: a wide window shows it beside the list. */
export function forgetItem() {
  if (inAddress() === undefined) return;
  history.replaceState({ ...history.state, item: undefined }, "", address(undefined));
  changed();
}
