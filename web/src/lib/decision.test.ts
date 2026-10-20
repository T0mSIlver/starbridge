import { expect, test } from "bun:test";
import { imageSrc } from "./attachments";
import { closedByPhrase, outcomeText } from "./outcome";
import type { InboxItem } from "./types";

// A 1x1 PNG, base64url with "-" and "_" where base64 has "+" and "/".
const pixel = {
  type: "image/png" as const,
  width: 1,
  height: 1,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg",
};

test("an image becomes a padded base64 data URL", () => {
  expect(imageSrc({ ...pixel, data: "-_8" })).toBe("data:image/png;base64,+/8=");
});

test("a decision answered elsewhere closes when its agent settles it", () => {
  const decision = {
    answerIn: { url: "https://claude.ai/artifact/2ig2" },
  } as InboxItem["decision"];
  const settled = { decision, answeredAt: "2026-10-05T11:30:00Z" } as InboxItem;
  expect(outcomeText(settled)).toBe("Answered in the artifact");
  expect(closedByPhrase(settled)).toBe("by the agent");
  const plain = { decision: { ...decision, answerIn: undefined } } as InboxItem;
  // Withdrawn by the agent, not answered by another device.
  const withdrawn = { ...plain, answeredAt: "2026-10-05T11:30:00Z", settled: "withdrawn" as const };
  expect(outcomeText(withdrawn)).toBe("Withdrawn");
  expect(closedByPhrase({ ...withdrawn, settled: undefined })).toBe("on another device");
  // Its reason takes the place of "by the agent" (#1008).
  expect(closedByPhrase(withdrawn)).toBe("by the agent");
  const why = "Fixed it myself after rereading the logs";
  expect(closedByPhrase({ ...withdrawn, reason: why })).toBe(why);
});

test("a question answered in the agent's own picker says the keyboard, not the agent (#865)", () => {
  const item = {
    decision: {},
    answeredAt: "2026-10-08T21:00:00Z",
    settled: "elsewhere",
  } as InboxItem;
  expect(outcomeText(item)).toBe("Answered");
  expect(closedByPhrase(item)).toBe("at the keyboard");
});
