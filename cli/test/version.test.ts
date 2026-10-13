import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beyondStamp, check, stamp } from "../scripts/version";

const ROOT = join(import.meta.dir, "..", "..");
const FILES = [
  "cli/package.json",
  "plugin/.claude-plugin/plugin.json",
  "mod/.claude-plugin/plugin.json",
  "web/package.json",
  "desktop/package.json",
  "mod/hooks/agent.ts",
  "android/app/build.gradle.kts",
  ".claude-plugin/marketplace.json",
];

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "starbridge-version-"));
  for (const f of FILES) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  return dir;
}

test("every place carries the CLI's version", () => {
  expect(check()).toEqual([]);
});

test("a release moves the marketplace to its tag; a release candidate leaves it", () => {
  const dir = copy();
  const ref = () => readFileSync(join(dir, ".claude-plugin/marketplace.json"), "utf8");
  const before = ref();
  stamp("7.1.0-rc.2", dir);
  expect(check("7.1.0-rc.2", dir)).toEqual([]);
  expect(ref()).toBe(before);
  stamp("7.1.0", dir);
  expect(check("7.1.0", dir)).toEqual([]);
  expect(ref().match(/"ref": "v7\.1\.0"/g)).toHaveLength(2);
  expect(check("7.1.1", dir)).toHaveLength(FILES.length + 1);
  writeFileSync(join(dir, ".claude-plugin/marketplace.json"), ref().replaceAll('"ref"', '"tag"'));
  expect(check("7.1.0", dir)).toEqual([".claude-plugin/marketplace.json: v(none), want v7.1.0"]);
});

test("rc numbers stop at 49, below the versionCodes of main's builds (#1540)", () => {
  const dir = copy();
  expect(() => stamp("7.1.0-rc.50", dir)).toThrow("rc numbers stop at 49");
  stamp("7.1.0-rc.49", dir);
  expect(check("7.1.0-rc.49", dir)).toEqual([]);
});

test("main follows a promoted final's marketplace and keeps its rc's version", () => {
  const dir = copy();
  stamp("7.1.0-rc.2", dir);
  stamp("7.1.0", dir, "marketplace");
  expect(check("7.1.0-rc.2", dir)).toEqual([]);
  expect(
    readFileSync(join(dir, ".claude-plugin/marketplace.json"), "utf8").match(/"ref": "v7\.1\.0"/g),
  ).toHaveLength(2);
});

test("a final release may change only the version stamp since its rc", () => {
  const rc = copy();
  stamp("9.8.7-rc.1", rc);
  const final = copy();
  stamp("9.8.7", final);
  const read = (dir: string) => (f: string) => readFileSync(join(dir, f), "utf8");
  expect(beyondStamp(FILES, read(rc), read(final))).toEqual([]);

  const pkg = join(final, "cli/package.json");
  writeFileSync(
    pkg,
    readFileSync(pkg, "utf8").replace('"version"', '"private": true,\n  "version"'),
  );
  expect(beyondStamp([...FILES, "cli/src/main.ts"], read(rc), read(final))).toEqual([
    "cli/package.json",
    "cli/src/main.ts",
  ]);
});
