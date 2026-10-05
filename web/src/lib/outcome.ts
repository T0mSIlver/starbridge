import type { DecisionLink } from "@starbridge/protocol";
import { linkLabel } from "./attachments";
import type { InboxItem, PromptItem } from "./types";

/** Where the owner answers a decision with `answerIn`: "the artifact" for a Claude one. */
export function answerPlace(link: DecisionLink): string {
  if (link.title) return link.title;
  const label = linkLabel(link);
  return label === "Claude artifact" ? "the artifact" : label;
}

/**
 * When the decision stopped waiting for the owner: its answer, or, for one answered on another
 * page, its default time, since no answer reaches Starbridge and the agent applies its default.
 */
export function closedAt(item: InboxItem, now: Date = new Date()): string | undefined {
  if (item.answeredAt) return item.answeredAt;
  const at = item.decision.answerIn && item.decision.default.at;
  return at && Date.parse(at) <= now.getTime() ? at : undefined;
}

/** The answer, or how a decision answered on another page closed. */
export function outcomeText(item: InboxItem): string {
  // Answers are sealed to the asking machine: only the device that sent one can show it.
  if (item.reply) return "choice" in item.reply ? item.reply.choice : item.reply.text;
  if (item.settled === "withdrawn") return "Withdrawn";
  const page = item.decision.answerIn;
  if (!page) return "Answered";
  return item.answeredAt ? `Answered in ${answerPlace(page)}` : "No answer by its default time";
}

/** Who closed it: this browser, the agent (withdrawn, or for another page), or another device. */
export function closedBy(item: InboxItem): string {
  if (item.reply) return "This browser";
  return item.settled || item.decision.answerIn ? "The agent" : "Another device";
}

/** How a prompt ended: "Allowed here", "Answered on devbox", "Timed out: left to the keyboard". */
export function promptOutcome(p: PromptItem, deviceName: (id: string) => string): string {
  if (p.reply) return p.reply.behavior === "allow" ? "Allowed here" : "Denied here";
  const out = p.settled?.outcome;
  if (out === "keyboard") return `Answered on ${p.permission.source.machine}`;
  if (out === "timeout") return "Timed out: left to the keyboard";
  if (out === "device" && p.settled?.device) return `Answered from ${deviceName(p.settled.device)}`;
  if (p.answeredAt) return "Answered on another device";
  return Date.parse(p.permission.expiresAt) > Date.now() ? "No longer waiting" : "Expired";
}

/** Who closed a question, after its answer in History: "on this browser", "by the agent". */
export function closedByPhrase(item: InboxItem): string {
  if (item.reply) return "on this browser";
  return item.settled || item.decision.answerIn ? "by the agent" : "on another device";
}
