import { expect, test } from "bun:test";
import { imageBlob, imageSrc, linkLabel } from "./attachments";
import { closedAt, closedBy, outcomeText } from "./outcome";
import type { InboxItem } from "./types";

// A 1x1 PNG, base64url with "-" and "_" where base64 has "+" and "/".
const pixel = {
  type: "image/png" as const,
  width: 1,
  height: 1,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg",
};

test("an image becomes a padded base64 data URL and a blob of the same bytes", async () => {
  const src = imageSrc({ ...pixel, data: "-_8" });
  expect(src).toBe("data:image/png;base64,+/8=");
  const bytes = new Uint8Array(await imageBlob(pixel).arrayBuffer());
  expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(bytes.length).toBe(70);
});

test("a link reads as its title, a Claude artifact, or its host and path", () => {
  expect(linkLabel({ url: "https://claude.ai/public/artifacts/0b3f", title: "Mockups" })).toBe(
    "Mockups",
  );
  expect(linkLabel({ url: "https://claude.ai/public/artifacts/0b3f" })).toBe("Claude artifact");
  expect(linkLabel({ url: "https://claude.ai/code/artifact/7c1d" })).toBe("Claude artifact");
  expect(linkLabel({ url: "https://www.example.com/" })).toBe("example.com");
  expect(linkLabel({ url: `https://example.com/${"a".repeat(60)}` })).toHaveLength(40);
});

test("a decision answered elsewhere closes when settled, or at its default time", () => {
  const decision = {
    default: { action: "Ship roomy", at: "2026-10-05T12:00:00Z" },
    answerIn: { url: "https://claude.ai/artifact/2ig2" },
  } as InboxItem["decision"];
  const item = { decision } as InboxItem;
  const before = new Date("2026-10-05T11:59:00Z");
  const after = new Date("2026-10-05T12:00:00Z");
  expect(closedAt(item, before)).toBeUndefined();
  expect(closedAt(item, after)).toBe("2026-10-05T12:00:00Z");
  expect(outcomeText(item)).toBe("No answer by its default time");
  const settled = { ...item, answeredAt: "2026-10-05T11:30:00Z" };
  expect(closedAt(settled, before)).toBe("2026-10-05T11:30:00Z");
  expect(outcomeText(settled)).toBe("Answered in the artifact");
  expect(closedBy(settled)).toBe("The agent");
  // A plain decision never closes by itself.
  const plain = { decision: { ...decision, answerIn: undefined } } as InboxItem;
  expect(closedAt(plain, after)).toBeUndefined();
  // Withdrawn by the agent, not answered by another device.
  const withdrawn = { ...plain, answeredAt: "2026-10-05T11:30:00Z", settled: "withdrawn" as const };
  expect(outcomeText(withdrawn)).toBe("Withdrawn");
  expect(closedBy(withdrawn)).toBe("The agent");
  expect(closedBy({ ...withdrawn, settled: undefined })).toBe("Another device");
});
