// What a notification says, the same from the service worker and the desktop app (#886).
import { contextText } from "@starbridge/protocol/context";
import type { InboxItem, PromptItem } from "./types";

/** The start of the context as plain text, for the notification body (#191, #969). */
export function summary(context: string): string {
  const text = contextText(context).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

/** A question's title, body and options, the recommended one first. */
export function questionNote(
  item: InboxItem,
  { waiting = false, back = false }: { waiting?: boolean; back?: boolean } = {},
): { title: string; body: string; options: string[] } {
  const d = item.decision;
  const options = d.recommended
    ? [d.recommended, ...d.options.filter((o) => o !== d.recommended)]
    : d.options;
  const state = back ? "Back from snooze · " : waiting ? "Waiting · " : "";
  return {
    title: d.question,
    body: `${state}${d.source.machine} · ${d.source.project}\n${summary(d.context)}`,
    options,
  };
}

/** A permission prompt's title and body; it has no buttons, since its input reads on the page. */
export function promptNote(item: PromptItem): { title: string; body: string } {
  const p = item.permission;
  return { title: `${p.tool} on ${p.source.machine}`, body: `${p.source.project}\n${p.summary}` };
}
