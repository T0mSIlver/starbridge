// What the desktop app shows, from the page's inbox and prompts (#886).
import type { DesktopEntry } from "./desktop";
import { needsYou } from "./feed";
import { promptNote, questionNote } from "./notes";
import type { InboxItem, PromptItem } from "./types";

/**
 * What the app shows: the Needs-you count, how many of those an agent waits on (its widget,
 * #1031), and one notification per item.
 */
export function desktopState(
  inbox: InboxItem[],
  prompts: PromptItem[],
  now: number,
): { count: number; waiting: number; entries: DesktopEntry[] } {
  const open = needsYou(inbox, prompts, now);
  const entries = open.map((e): DesktopEntry => {
    if (e.type === "prompt")
      return { id: e.id, ...promptNote(e.item), options: [], reply: false, waiting: true };
    const item = e.item as InboxItem;
    const waiting = !!item.waitingSince;
    const d = item.decision;
    // A question answered on another page opens the window, where its link is.
    const note = questionNote(item, { waiting });
    return {
      id: e.id,
      ...note,
      options: d.answerIn ? [] : note.options,
      reply: !d.answerIn && (d.options.length === 0 || !!d.replies),
      waiting,
    };
  });
  return { count: open.length, waiting: entries.filter((e) => e.waiting).length, entries };
}
