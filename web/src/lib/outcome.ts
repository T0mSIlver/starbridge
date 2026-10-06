import type { DecisionLink } from "@starbridge/protocol";
import { linkLabel } from "./attachments";
import type { InboxItem, PromptItem } from "./types";

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

/** Who closed a question, after its answer in History: "on this browser", "by the agent". */
export function closedByPhrase(item: InboxItem): string {
  if (item.reply) return "on this browser";
  return item.settled || item.decision.answerIn ? "by the agent" : "on another device";
}
