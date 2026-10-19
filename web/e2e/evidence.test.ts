import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { compare, difference, parts, screens } from "./evidence.ts";

/** A 10 × 10 white PNG with the given pixels black. */
function png(black: [number, number][] = [], width = 10): Buffer {
  const p = new PNG({ width, height: 10 });
  p.data.fill(255);
  for (const [x, y] of black) p.data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return PNG.sync.write(p);
}

test("counts the pixels that differ, outside the boxes that change from run to run", () => {
  const changed = png([
    [1, 1],
    [8, 8],
  ]);
  expect(difference(png(), changed)).toBe(0.02);
  expect(difference(png(), changed, [{ x: 0.5, y: 0.5, width: 2, height: 2 }])).toBe(0.01);
});

test("another size is a whole change", () => {
  expect(difference(png(), png([], 11))).toBe(1);
});

test("finds a part whether its artifact sits in a subfolder or alone in the folder", () => {
  const manifest = JSON.stringify({ shard: "app", passed: true, steps: [] });
  const alone = mkdtempSync(join(tmpdir(), "evidence-"));
  writeFileSync(join(alone, "manifest.json"), manifest);
  const several = mkdtempSync(join(tmpdir(), "evidence-"));
  mkdirSync(join(several, "x"));
  writeFileSync(join(several, "x", "manifest.json"), manifest);
  expect(parts(alone).map((p) => p.manifest.shard)).toEqual(["app"]);
  expect(parts(several).map((p) => p.manifest.shard)).toEqual(["app"]);
});

test("the changed screens come largest first, one entry per screen", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  const write = (name: string, black: [number, number][]) => {
    const f = join(dir, name);
    writeFileSync(f, png(black));
    return f;
  };
  const many: [number, number][] = [...Array(30).keys()].map((i) => [i % 10, Math.floor(i / 10)]);
  const base = new Map([
    ["a-phone-light.png", write("a1.png", [])],
    ["a-phone-dark.png", write("a2.png", [])],
    ["b-tablet-light.png", write("b1.png", [])],
  ]);
  const pr = new Map([
    ["a-phone-light.png", write("a3.png", [[1, 1]])],
    ["a-phone-dark.png", write("a4.png", [[1, 1]])],
    ["b-tablet-light.png", write("b2.png", many)],
  ]);
  const changes = compare(pr, base);
  expect(changes.map((c) => c.name)).toEqual([
    "b-tablet-light.png",
    "a-phone-dark.png",
    "a-phone-light.png",
  ]);
  expect(screens(changes)).toBe("`b` 1, `a` 2");
});
