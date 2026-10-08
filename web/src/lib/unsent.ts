import type { InboxItem, Reply } from "./types";

/** This page's answers the server has yet to take, by decision id, with when each was given. */
export type Unsent = Record<string, { reply: Reply; at: string }>;

/**
 * Lays this page's unsent answers over the inbox's items: a question leaves the open list the
 * moment it is answered, and comes back with why if the server refuses the answer (#895).
 */
export function withUnsent(
  items: InboxItem[],
  unsent: Unsent,
  notSent: Record<string, string>,
): InboxItem[] {
  return items.map((i) => {
    if (i.answeredAt) return i;
    const u = unsent[i.decision.id];
    if (u) return { ...i, answeredAt: u.at, reply: u.reply, sending: true };
    const why = notSent[i.decision.id];
    return why ? { ...i, notSent: why } : i;
  });
}
