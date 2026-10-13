import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pageHash, privacyChanges } from "./changes";

const pageText = () =>
  readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
    .replace(/\s+/g, " ")
    .trim();

test("an edit to /privacy comes with a dated entry in its Changes list", () => {
  const hash = createHash("sha256").update(pageText()).digest("hex");
  expect(
    hash,
    `page.tsx changed: add an entry to privacyChanges in changes.ts dated today, saying what changed, then set pageHash to "${hash}"`,
  ).toBe(pageHash);
});

test("the Changes list runs newest first", () => {
  const dates = privacyChanges.map((c) => c.date);
  expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  expect(dates).toEqual([...dates].sort().reverse());
});
