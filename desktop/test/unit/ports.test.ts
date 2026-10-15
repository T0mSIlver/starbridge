import { expect, test } from "bun:test";
import { freePorts } from "../ports.ts";

test("freePorts hands out distinct ports", async () => {
  const names = Array.from({ length: 16 }, (_, i) => `s${i}`);
  const ports = await freePorts(names);
  expect(new Set(Object.values(ports)).size).toBe(16);
});
