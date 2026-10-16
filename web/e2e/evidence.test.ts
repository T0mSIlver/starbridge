import { expect, test } from "bun:test";
import { PNG } from "pngjs";
import { difference } from "./evidence.ts";

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
