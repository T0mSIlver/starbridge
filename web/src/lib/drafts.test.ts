import { expect, test } from "bun:test";
import { drafts, dropClosedDrafts } from "./drafts";
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
