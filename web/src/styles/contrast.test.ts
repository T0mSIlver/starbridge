import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// DESIGN.md's tokens, which every client is generated from: `fg3`, the hint tier, is text and
// needs 4.5:1 (WCAG AA) on the three grounds; `line-strong` borders a field or a button and
// needs 3:1 (WCAG 1.4.11) against them (#1939, #1940).
const design = /^---\n([\s\S]*?)\n---\n/.exec(
  readFileSync(resolve(import.meta.dir, "../../../DESIGN.md"), "utf8"),
);
const colors = (
  Bun.YAML.parse(design?.[1] ?? "") as { colors: Record<string, Record<string, string>> }
).colors;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("token contrast", () => {
  for (const scheme of ["light", "dark"] as const) {
    const c = colors[scheme] as Record<string, string>;
    for (const ground of ["bg", "surface", "surface2"]) {
      test(`${scheme} fg3 on ${ground} reaches 4.5:1`, () => {
        expect(ratio(c.fg3 as string, c[ground] as string)).toBeGreaterThanOrEqual(4.5);
      });
      test(`${scheme} line-strong on ${ground} reaches 3:1`, () => {
        expect(ratio(c["line-strong"] as string, c[ground] as string)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
