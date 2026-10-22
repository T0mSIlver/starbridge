import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_STORAGE_KEYS, readStored, stored, writable } from "./stored";

test("a stored value carries its format, and one in a newer format is kept, not replaced", () => {
  expect(JSON.parse(stored({ theme: "dark" }))).toEqual({ v: 1, theme: "dark" });
  expect(readStored("k", stored({ theme: "dark" }))).toEqual({ theme: "dark" });
  expect(readStored("k", '{"theme":"dark"}')).toBeNull();
  expect(writable('{"theme":"dark"}')).toBe(true);
  const newer = '{"v":2,"theme":{"mode":"dark"}}';
  expect(readStored("k", newer)).toBeNull();
  expect(writable(newer)).toBe(false);
  expect(readStored("k", "{ not json")).toBeNull();
  expect(writable("{ not json")).toBe(true);
  expect(writable(null)).toBe(true);
});

test("every localStorage key of the app is listed as account data, or is the display prefs (#2014)", () => {
  const listed = new Set<string>(Object.values(ACCOUNT_STORAGE_KEYS));
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
        for (const m of readFileSync(path, "utf8").matchAll(/"(starbridge:[a-z-]+)"/g))
          found.add(m[1] as string);
    }
  };
  walk(join(import.meta.dir, ".."));
  // Message types of the service worker are not storage keys.
  for (const key of found) {
    if (
      key === "starbridge:prefs" ||
      key.startsWith("starbridge:push") ||
      key === "starbridge:open"
    )
      continue;
    expect(listed.has(key), `${key} holds account data? add it to ACCOUNT_STORAGE_KEYS`).toBe(true);
  }
});
