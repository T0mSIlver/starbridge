import { expect, test } from "bun:test";
import { capReply, drafts, dropClosedDrafts, REPLY_LIMIT } from "./drafts";
import type { InboxItem } from "./types";

const item = (id: string, over: Partial<InboxItem> = {}) =>
  ({ decision: { id }, ...over }) as unknown as InboxItem;

test("a question closed elsewhere drops its draft; an open or snoozed one keeps it (#1189)", () => {
  drafts.set("d_answered", "a");
  drafts.set("d_open", "b");
  drafts.set("d_snoozed", "c");
  drafts.set("d_not_listed", "d");
  dropClosedDrafts([
    item("d_answered", { answeredAt: "2026-10-11T10:00:00Z" }),
    item("d_open"),
    item("d_snoozed", { snoozedUntil: "2026-10-11T18:00:00Z" }),
  ]);
  expect([...drafts.keys()].sort()).toEqual(["d_not_listed", "d_open", "d_snoozed"]);
  drafts.clear();
});

test("a reply stops at the server's 4000 characters, never inside an emoji (#1921)", () => {
  expect(REPLY_LIMIT).toBe(4000);
  expect(capReply("x".repeat(4001))).toBe("x".repeat(4000));
  expect(capReply("x".repeat(4000))).toBe("x".repeat(4000));
  expect(capReply("short")).toBe("short");
  // The 4000th unit is the first half of a pair: the whole emoji goes.
  expect(capReply(`${"x".repeat(3999)}😀y`)).toBe("x".repeat(3999));
});
