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

/** The longest reply the server takes: the Answer schema's 4000 UTF-16 units (#1921). */
export const REPLY_LIMIT = 4000;

/**
 * A reply cut to `REPLY_LIMIT`, as Android and iOS cap their fields (#1921). An emoji cut in two,
 * here or by the field's `maxLength`, loses its first half too: the server refuses a lone one.
 */
export function capReply(text: string): string {
  const cut = text.slice(0, REPLY_LIMIT);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
