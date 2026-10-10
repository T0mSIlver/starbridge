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
  ["too many entries", { count: 201, entries: Array(201).fill(entry) }],
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
