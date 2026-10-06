import { expect, test } from "bun:test";
import { readStored, stored, writable } from "./stored";

test("a stored value carries its format, and one this page cannot read is kept, not replaced", () => {
  expect(JSON.parse(stored({ theme: "dark" }))).toEqual({ v: 1, theme: "dark" });
  expect(readStored("k", stored({ theme: "dark" }))).toEqual({ theme: "dark" });
  // Without `v`: format 1.
  expect(readStored("k", '{"theme":"dark"}')).toEqual({ theme: "dark" });
  const newer = '{"v":2,"theme":{"mode":"dark"}}';
  expect(readStored("k", newer)).toBeNull();
  expect(writable(newer)).toBe(false);
  expect(readStored("k", "{ not json")).toBeNull();
  expect(writable("{ not json")).toBe(true);
  expect(writable(null)).toBe(true);
});
