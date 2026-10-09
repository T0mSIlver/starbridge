import { expect, test } from "bun:test";
import { githubLink, imageSrc, linkLabel } from "./attachments";
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

test("a link reads as its title, a Claude artifact, or its host and path", () => {
  expect(linkLabel({ url: "https://claude.ai/public/artifacts/0b3f", title: "Mockups" })).toBe(
    "Mockups",
  );
  expect(linkLabel({ url: "https://claude.ai/public/artifacts/0b3f" })).toBe("Claude artifact");
  expect(linkLabel({ url: "https://claude.ai/code/artifact/7c1d" })).toBe("Claude artifact");
  expect(linkLabel({ url: "https://www.example.com/" })).toBe("example.com");
  // Passes the schema but not URL: shown as written rather than crashing the inbox.
  expect(linkLabel({ url: "https://%" })).toBe("https://%");
  expect(linkLabel({ url: `https://example.com/${"a".repeat(60)}` })).toHaveLength(40);
});

// The same cases as Android's LinksTest, so both clients label a GitHub link alike (#971).
test("a GitHub link reads as its reference, led by its repo when it isn't the session's", () => {
  const gh = "https://github.com/T0mSIlver/starbridge";
  const label = (url: string, title?: string) => linkLabel({ url, title }, "starbridge");
  expect(label(`${gh}/pull/86/files#diff`)).toBe("#86");
  expect(label(`${gh}/pull/86`, "Merge plan")).toBe("#86");
  expect(label("https://GitHub.com/T0mSIlver/Starbridge/issues/171")).toBe("#171");
  expect(label(`${gh}/discussions/12`)).toBe("#12");
  expect(label(`${gh}/releases/tag/v0.1.2`)).toBe("v0.1.2");
  expect(label(`${gh}/commit/63141e89a2b4c`)).toBe("63141e8");
  expect(label("https://github.com/steipete/CodexBar/pull/412")).toBe("CodexBar#412");
  expect(label("https://github.com/steipete/CodexBar/releases/tag/v1.2")).toBe("CodexBar v1.2");
  expect(label(`${gh}/actions/runs/18234567890/job/5`)).toBe("Actions run");
  expect(label(`${gh}/actions/runs/18234567890`, "CI on #934")).toBe("CI on #934");
  expect(label(`${gh}/pulls`)).toBe("T0mSIlver/starbridge/pulls");
  expect(label("https://github.com/")).toBe("GitHub");
  // Without a session's project, as for "Answer in", the repo always leads.
  expect(linkLabel({ url: `${gh}/pull/86` })).toBe("starbridge#86");
});

test("a GitHub link's kind picks its Octicon", () => {
  const kind = (path: string) => githubLink(`https://github.com/o/r${path}`)?.kind;
  expect(kind("/pull/1")).toBe("pull");
  expect(kind("/issues/2")).toBe("issue");
  expect(kind("/discussions/3")).toBe("discussion");
  expect(kind("/actions/runs/4")).toBe("run");
  expect(kind("/releases/tag/v1")).toBe("release");
  expect(kind("/commit/abcdef1")).toBe("commit");
  expect(kind("/pull/new")).toBe("other");
  expect(kind("/releases")).toBe("other");
  expect(githubLink("http://github.com/o/r/pull/1")).toBeUndefined();
  expect(githubLink("https://gist.github.com/o/1")).toBeUndefined();
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
