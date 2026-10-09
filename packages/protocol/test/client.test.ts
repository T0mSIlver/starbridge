import { expect, test } from "bun:test";
import { parseClientHeader, versionBelow } from "../src";

test.each([
  ["cli/1.0.0", { name: "cli", version: [1, 0, 0], pre: false }],
  ["android/1.2.10-rc.1", { name: "android", version: [1, 2, 10], pre: true }],
  ["desktop/0.1.0", { name: "desktop", version: [0, 1, 0], pre: false }],
  ["phone/1.0.0", null],
  ["cli/1.0", null],
  ["cli/abc1234", null],
  ["cli", null],
  [undefined, null],
])("%s reads as %j", (header, expected) => {
  expect(parseClientHeader(header)).toEqual(expected as ReturnType<typeof parseClientHeader>);
});

test.each([
  ["cli/1.0.9", "1.1.0", true],
  ["cli/1.10.0", "1.9.0", false],
  ["cli/1.2.0", "1.2.0", false],
  ["cli/1.2.0-rc.1", "1.2.0", true],
  ["cli/1.2.1-rc.1", "1.2.0", false],
  ["cli/0.9.9", "1.0.0", true],
])("%s below %s: %s", (header, minimum, below) => {
  const client = parseClientHeader(header);
  if (!client) throw new Error(header);
  expect(versionBelow(client, minimum)).toBe(below);
});

test("a minimum is a release, not a pre-release", () => {
  expect(() => versionBelow({ version: [1, 0, 0], pre: false }, "1.1.0-rc.1")).toThrow();
});
