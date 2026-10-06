import { expect, test } from "bun:test";
import { parseClientHeader, versionBelow } from "../src";

test.each([
  ["cli/1.0.0", { name: "cli", version: [1, 0, 0] }],
  ["android/1.2.10-rc.1", { name: "android", version: [1, 2, 10] }],
  ["phone/1.0.0", null],
  ["cli/1.0", null],
  ["cli/abc1234", null],
  ["cli", null],
  [undefined, null],
])("%s reads as %j", (header, expected) => {
  expect(parseClientHeader(header)).toEqual(expected as ReturnType<typeof parseClientHeader>);
});

test.each([
  [[1, 0, 9], "1.1.0", true],
  [[1, 10, 0], "1.9.0", false],
  [[1, 2, 0], "1.2.0", false],
  [[1, 2, 0], "1.2.0-rc.1", false],
  [[0, 9, 9], "1.0.0", true],
] as const)("%j below %s: %s", (version, minimum, below) => {
  expect(versionBelow([...version], minimum)).toBe(below);
});
