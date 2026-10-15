import { expect, test } from "bun:test";
import { type Looks, unwatched } from "./freshBuild";

const idle = { away: false, idleMs: 90_000 };
const looks = (l: Partial<Looks>): Looks => ({
  hidden: false,
  screen: idle,
  sinceInput: 90_000,
  editing: false,
  ...l,
});

test("a shown desktop window counts as unwatched once the Mac sat idle a minute, or locked", () => {
  expect(unwatched(looks({}))).toBe(true);
  expect(unwatched(looks({ screen: { away: true, idleMs: null } }))).toBe(true);
  expect(unwatched(looks({ screen: { away: false, idleMs: 30_000 } }))).toBe(false);
});

test("input in the page, a focused field or an open dialog keeps a shown window watched", () => {
  // The Mac's reading lags up to 10 s; the page's own input is current.
  expect(unwatched(looks({ sinceInput: 5_000 }))).toBe(false);
  expect(unwatched(looks({ editing: true }))).toBe(false);
});

test("a browser tab counts as unwatched only while hidden", () => {
  expect(unwatched(looks({ screen: undefined }))).toBe(false);
  expect(unwatched(looks({ screen: undefined, hidden: true }))).toBe(true);
});
