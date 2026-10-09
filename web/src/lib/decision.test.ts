import { expect, test } from "bun:test";
import { imageSrc, linkLabel } from "./attachments";
import { closedBy, closedByPhrase, outcomeText } from "./outcome";
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

test("a link reads as its title, a GitHub reference, a Claude artifact, or its host and path", () => {
  expect(linkLabel({ url: "https://claude.ai/public/artifacts/0b3f", title: "Mockups" })).toBe(
    "Mockups",
  );
  expect(linkLabel({ url: "https://claude.ai/public/artifacts/0b3f" })).toBe("Claude artifact");
  expect(linkLabel({ url: "https://claude.ai/code/artifact/7c1d" })).toBe("Claude artifact");
  expect(linkLabel({ url: "https://www.example.com/" })).toBe("example.com");
  expect(linkLabel({ url: "https://github.com/T0mSIlver/starbridge/pull/86/files#diff" })).toBe(
    "T0mSIlver/starbridge#86",
  );
  expect(linkLabel({ url: "https://github.com/T0mSIlver/starbridge/issues/171" })).toBe(
    "T0mSIlver/starbridge#171",
  );
  expect(linkLabel({ url: "https://GitHub.com/T0mSIlver/starbridge/pull/86" })).toBe(
    "T0mSIlver/starbridge#86",
  );
  expect(linkLabel({ url: "https://github.com/T0mSIlver/starbridge/pulls" })).toBe(
    "github.com/T0mSIlver/starbridge/pulls",
  );
  // Passes the schema but not URL: shown as written rather than crashing the inbox.
  expect(linkLabel({ url: "https://%" })).toBe("https://%");
  expect(linkLabel({ url: `https://example.com/${"a".repeat(60)}` })).toHaveLength(40);
});

test("a decision answered elsewhere closes when its agent settles it", () => {
  const decision = {
    answerIn: { url: "https://claude.ai/artifact/2ig2" },
  } as InboxItem["decision"];
  const settled = { decision, answeredAt: "2026-10-05T11:30:00Z" } as InboxItem;
  expect(outcomeText(settled)).toBe("Answered in the artifact");
  expect(closedBy(settled)).toBe("The agent");
  const plain = { decision: { ...decision, answerIn: undefined } } as InboxItem;
  // Withdrawn by the agent, not answered by another device.
  const withdrawn = { ...plain, answeredAt: "2026-10-05T11:30:00Z", settled: "withdrawn" as const };
  expect(outcomeText(withdrawn)).toBe("Withdrawn");
  expect(closedBy(withdrawn)).toBe("The agent");
  expect(closedBy({ ...withdrawn, settled: undefined })).toBe("Another device");
});

test("a question answered in the agent's own picker says the keyboard, not the agent (#865)", () => {
  const item = {
    decision: {},
    answeredAt: "2026-10-08T21:00:00Z",
    settled: "elsewhere",
  } as InboxItem;
  expect(outcomeText(item)).toBe("Answered");
  expect(closedByPhrase(item)).toBe("at the keyboard");
  expect(closedBy(item)).toBe("The keyboard");
});
