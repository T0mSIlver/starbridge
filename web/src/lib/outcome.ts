import type { DecisionLink } from "@starbridge/protocol";
import { linkLabel } from "./attachments";
import type { Decision, InboxItem, PromptItem, Reply } from "./types";

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
  // Answers are sealed to the asking machine: another device's shows once the machine names it.
  const reply = item.reply ?? item.answeredBy?.reply;
  if (reply) return replyText(reply, item.decision);
  if (item.settled === "withdrawn") return "Withdrawn";
  const page = item.decision.answerIn;
  if (!page) return "Answered";
  return `Answered in ${answerPlace(page)}`;
}

/** What a reply says: the choice, the text, or for Done where it was answered. */
export function replyText(reply: Reply, d: Decision): string {
  if ("choice" in reply) return reply.choice;
  if ("text" in reply) return reply.text;
  return d.answerIn ? `Answered in ${answerPlace(d.answerIn)}` : "Answered";
}

/**
 * Who closed it: this browser, another device, the keyboard (the harness's own picker or
 * terminal, #865), or the agent (withdrawn, or for another page).
 */
export function closedBy(item: InboxItem): string {
  if (item.reply) return "This browser";
  if (item.answeredBy) return item.answeredBy.device;
  if (atKeyboard(item)) return "The keyboard";
  return item.settled || item.decision.answerIn ? "The agent" : "Another device";
}

const allowed = {
  once: "Allowed once",
  session: "Allowed for this session",
  project: "Always allowed",
};

/**
 * How a prompt ended and where, as History puts it: "Denied", "on Pixel". The where is empty
 * when nobody answered (timed out, expired).
 */
export function promptOutcome(
  p: PromptItem,
  deviceName: (id: string) => string,
): { outcome: string; by: string } {
  if (p.reply)
    return {
      outcome: p.reply.behavior === "allow" ? allowed[p.reply.scope] : "Denied",
      by: "on this browser",
    };
  const s = p.settled;
  if (s?.outcome === "keyboard")
    return { outcome: "Answered", by: `on ${p.permission.source.machine}` };
  if (s?.outcome === "timeout") return { outcome: "Timed out: left to the keyboard", by: "" };
  if (s?.outcome === "device" && s.device) {
    const outcome =
      s.behavior === "allow" ? "Allowed" : s.behavior === "deny" ? "Denied" : "Answered";
    return { outcome, by: `on ${deviceName(s.device)}` };
  }
  if (p.answeredAt) return { outcome: "Answered", by: "on another device" };
  const left = Date.parse(p.permission.expiresAt) > Date.now();
  return { outcome: left ? "No longer waiting" : "Expired", by: "" };
}

/** This browser's answer lost to another device's (#330). */
export class AnsweredFirst extends Error {}

/** Why this browser's answer was not sent: what won, once the machine said. */
export function answeredFirstText(item: InboxItem): string {
  const by = item.answeredBy;
  if (!by) return "Already answered on another device.";
  if ("done" in by.reply) return `Marked answered on ${by.device}.`;
  return `Answered on ${by.device}: ${replyText(by.reply, item.decision)}`;
}

/** Who closed a question, after its answer in History: "on this browser", "by the agent". */
export function closedByPhrase(item: InboxItem): string {
  if (item.reply) return "on this browser";
  if (item.answeredBy) return `on ${item.answeredBy.device}`;
  if (atKeyboard(item)) return "at the keyboard";
  return item.settled || item.decision.answerIn ? "by the agent" : "on another device";
}

/** Settled `elsewhere` with no page to answer in: the owner answered in the agent's own picker. */
function atKeyboard(item: InboxItem): boolean {
  return item.settled === "elsewhere" && !item.decision.answerIn;
}
