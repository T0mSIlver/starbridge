import type { DecisionLink } from "@starbridge/protocol";
import { linkLabel } from "./attachments";
import type { InboxItem } from "./types";

/** Where the owner answers a decision with `answerIn`: "the artifact" for a Claude one. */
export function answerPlace(link: DecisionLink): string {
  if (link.title) return link.title;
  const label = linkLabel(link);
  return label === "Claude artifact" ? "the artifact" : label;
}

/** When the decision stopped waiting for the owner: answered, or settled by its agent. */
export function closedAt(item: InboxItem): string | undefined {
  return item.answeredAt;
}

/** The answer, or how a decision answered on another page closed. */
export function outcomeText(item: InboxItem): string {
  // Answers are sealed to the asking machine: only the device that sent one can show it.
  if (item.reply) return "choice" in item.reply ? item.reply.choice : item.reply.text;
  if (item.settled === "withdrawn") return "Withdrawn";
  const page = item.decision.answerIn;
  if (!page) return "Answered";
  return `Answered in ${answerPlace(page)}`;
}

/** Who closed it: this browser, the agent (withdrawn, or for another page), or another device. */
export function closedBy(item: InboxItem): string {
  if (item.reply) return "This browser";
  return item.settled || item.decision.answerIn ? "The agent" : "Another device";
}
