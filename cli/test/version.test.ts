import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, stamp } from "../scripts/version";

const ROOT = join(import.meta.dir, "..", "..");
const FILES = [
  "cli/package.json",
  "plugin/.claude-plugin/plugin.json",
  "mod/.claude-plugin/plugin.json",
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
});
