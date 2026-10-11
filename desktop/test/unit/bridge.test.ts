import { expect, test } from "bun:test";
import { parseAnswered, parseState } from "../../src/bridge";

const entry = {
  id: "d-1",
  title: "Ship it?",
  body: "devbox · starbridge",
  options: ["yes", "no"],
  reply: true,
  waiting: false,
};

test("a page's state reads as sent", () => {
  const state = { count: 2, entries: [entry], waiting: 1, account: "ready" as const };
  expect(parseState(state)).toEqual(state);
});

test("past 200 entries, the first 200 are kept with the full count", () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ ...entry, id: `d-${i}` }));
  const s = parseState({ count: 250, entries, waiting: 0 });
  expect(s?.count).toBe(250);
  expect(s?.entries.map((e) => e.id)).toEqual(entries.slice(0, 200).map((e) => e.id));
});

test("a page before #1031 with over 200 entries counts the waiting among all of them", () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({
    ...entry,
    id: `d-${i}`,
    waiting: i >= 240,
  }));
  expect(parseState({ count: 250, entries })?.waiting).toBe(10);
});

test("a page before #1031 counts the waiting from its entries", () => {
  expect(parseState({ count: 1, entries: [{ ...entry, waiting: true }] })).toMatchObject({
    waiting: 1,
    account: "ready",
  });
});

test("long text is cut, not refused", () => {
  const s = parseState({ count: 1, entries: [{ ...entry, title: "x".repeat(400) }] });
  expect(s?.entries[0]?.title).toHaveLength(300);
});

test.each([
  ["no entries", { count: 1 }],
  ["a fractional count", { count: 1.5, entries: [] }],
  ["a negative count", { count: -1, entries: [] }],
  ["an id with a slash", { count: 1, entries: [{ ...entry, id: "../x" }] }],
  ["five options", { count: 1, entries: [{ ...entry, options: ["a", "b", "c", "d", "e"] }] }],
  ["an empty option", { count: 1, entries: [{ ...entry, options: ["", "b"] }] }],
  ["a function", { count: 1, entries: [{ ...entry, title: () => 1 }] }],
  ["an array", []],
  ["more waiting than counted", { count: 1, entries: [], waiting: 2 }],
  ["an unknown account", { count: 0, entries: [], account: "admin" }],
])("%s is refused", (_why, x) => {
  expect(parseState(x)).toBeNull();
});

test("an answer's outcome reads with or without an error", () => {
  expect(parseAnswered({ id: "d-1" })).toEqual({ id: "d-1" });
  expect(parseAnswered({ id: "d-1", error: "offline" })).toEqual({ id: "d-1", error: "offline" });
  expect(parseAnswered({ id: "d-1", error: 3 })).toBeNull();
});
