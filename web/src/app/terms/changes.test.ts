import { expect, test } from "bun:test";
import { sourceHash } from "@/lib/legalChanges";
import { pageHash, termsChanges } from "./changes";

test("an edit to /terms comes with a dated entry in its Changes list", () => {
  const hash = sourceHash(new URL("./page.tsx", import.meta.url));
  expect(
    hash,
    `page.tsx changed: add an entry to termsChanges in changes.ts dated today, saying what changed, then set pageHash to "${hash}"`,
  ).toBe(pageHash);
});

test("the Changes list runs newest first", () => {
  const dates = termsChanges.map((c) => c.date);
  expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  expect(dates).toEqual([...dates].sort().reverse());
});
