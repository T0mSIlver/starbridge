import { closedAt } from "./outcome";
import type { InboxItem } from "./types";

/**
 * Replies typed but not sent, by question, until the page reloads (#992): one survives its detail
 * moving between the phone and wide layouts, and a visit to Settings, as Android keeps them.
 */
export const drafts = new Map<string, string>();

/**
 * Drops the drafts of questions closed elsewhere: answered on another device, settled or
 * withdrawn (#1189). A kept one would hold off the hidden page's reload for good. A snoozed
 * question is still open and keeps its draft.
 */
export function dropClosedDrafts(inbox: InboxItem[]): void {
  for (const i of inbox) if (closedAt(i)) drafts.delete(i.decision.id);
}

/** The longest reply the server takes: the Answer schema's 4000, which zod counts in code points. */
export const REPLY_LIMIT = 4000;

/**
 * A reply cut to its first `REPLY_LIMIT` code points, as Android and iOS cap their fields (#1921):
 * a cut never splits an emoji's pair, which the server refuses.
 */
export function capReply(text: string): string {
  // Each code point is at most 2 units, so a text this short needs no count.
  if (text.length <= REPLY_LIMIT) return text;
  const points = Array.from(text);
  return points.length <= REPLY_LIMIT ? text : points.slice(0, REPLY_LIMIT).join("");
}
