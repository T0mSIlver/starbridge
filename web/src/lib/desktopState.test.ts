import { expect, test } from "bun:test";
import { desktopState } from "./desktopState";
import type { InboxItem, PromptItem } from "./types";

const source = { machine: "devbox", project: "starbridge", session: "s1" };
const NOW = Date.parse("2026-10-08T12:00:00Z");

function question(
  id: string,
  extra: Partial<InboxItem["decision"]> = {},
  item: Partial<InboxItem> = {},
) {
  return {
    decision: {
      v: 1,
      id,
      to: [],
      createdAt: "2026-10-08T11:00:00Z",
      question: "Ship it?",
      context: "The `checkout` tests pass.\n```\nlog\n```",
      options: ["no", "yes"],
      recommended: "yes",
      source,
      ...extra,
    },
    machine: { id: "m1" },
    ...item,
  } as unknown as InboxItem;
}

const prompt = {
  permission: {
    id: "p1",
    tool: "Bash",
    summary: "rm -rf build",
    source,
    createdAt: "2026-10-08T11:30:00Z",
    expiresAt: "2026-10-08T13:00:00Z",
  },
} as unknown as PromptItem;

test("the count and one entry per item in Needs you, prompts first", () => {
  const s = desktopState(
    [
      question("d1", {}, { waitingSince: "2026-10-08T11:10:00Z" }),
      question("d2", {}, { answeredAt: "2026-10-08T11:20:00Z" }),
      question("d3", {}, { snoozedUntil: "2026-10-08T18:00:00Z" }),
    ],
    [prompt],
    NOW,
  );
  expect(s.count).toBe(2);
  expect(s.waiting).toBe(2);
  expect(s.entries).toEqual([
    {
      id: "p1",
      title: "Bash on devbox",
      body: "starbridge\nrm -rf build",
      options: [],
      reply: false,
      waiting: true,
    },
    {
      id: "d1",
      title: "Ship it?",
      body: "Waiting · devbox · starbridge\nThe checkout tests pass. log",
      options: ["yes", "no"],
      reply: false,
      waiting: true,
    },
  ]);
});

test("typed answers: a question without options, or one that takes replies", () => {
  const [typed, both] = desktopState(
    [question("d1", { options: [], recommended: undefined }), question("d2", { replies: true })],
    [],
    NOW,
  ).entries;
  expect(typed).toMatchObject({ options: [], reply: true, waiting: false });
  expect(both).toMatchObject({ options: ["yes", "no"], reply: true });
});

test("a question answered on another page has no buttons: a click opens the window", () => {
  const answerIn = { url: "https://claude.ai/code/session_1", label: "Claude" };
  const [e] = desktopState(
    [question("d1", { options: [], recommended: undefined, answerIn })],
    [],
    NOW,
  ).entries;
  expect(e).toMatchObject({ options: [], reply: false });
});
