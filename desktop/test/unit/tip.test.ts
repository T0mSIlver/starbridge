import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { tipVersion } from "../../scripts/tip";

// The semver electron-updater compares versions with, so the order below is the updater's.
const semver = createRequire(require.resolve("electron-updater"))("semver") as {
  gt(a: string, b: string): boolean;
};

test("a tip build takes the version under way", () => {
  expect(tipVersion("0.1.7-rc.3", false, 12)).toBe("0.1.7-tip.12");
  // Once the final is out, or the package names one, the next patch.
  expect(tipVersion("0.1.7-rc.3", true, 13)).toBe("0.1.8-tip.13");
  expect(tipVersion("0.1.7", false, 14)).toBe("0.1.8-tip.14");
  expect(() => tipVersion("0.1.7-tip.2", false, 3)).toThrow();
});

test("the updater orders tip builds above their version's rcs and below its final", () => {
  const order = [
    "0.1.6",
    "0.1.7-rc.1",
    "0.1.7-rc.12",
    "0.1.7-tip.2",
    "0.1.7-tip.12",
    "0.1.7",
    "0.1.8-rc.1",
    "0.1.8-tip.1",
  ];
  for (let i = 1; i < order.length; i++)
    expect(semver.gt(order[i] as string, order[i - 1] as string)).toBe(true);
});
