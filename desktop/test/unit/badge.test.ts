import { expect, test } from "bun:test";
import { badgeText } from "../../src/badge";
import type { PageState } from "../../src/bridge";

const state = (s: Partial<PageState>): PageState => ({
  count: 3,
  entries: [],
  waiting: 1,
  account: "ready",
  ...s,
});

test("the Dock badge is the Needs-you count, cleared at 0 and signed out, kept while loading", () => {
  expect(badgeText(state({ count: 1 }))).toBe("1");
  expect(badgeText(state({ count: 99 }))).toBe("99");
  expect(badgeText(state({ count: 128 }))).toBe("128");
  expect(badgeText(state({ count: 0, waiting: 0 }))).toBe("");
  expect(badgeText(state({ account: "signedOut", count: 0, waiting: 0 }))).toBe("");
  expect(badgeText(state({ account: "loading" }))).toBeNull();
});
