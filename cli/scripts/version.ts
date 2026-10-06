/**
 * The one Starbridge version, stamped into every place that carries it.
 *
 *   bun cli/scripts/version.ts <version>          stamp it, for the release commit the tag points at
 *   bun cli/scripts/version.ts --check [version]  fail unless every place says it (default: the CLI's)
 *
 * A release candidate moves every version but leaves the marketplace on the last release, so
 * only users who pin an rc get its plugins.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const NUMBER = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;

/** Each place: its file and the one pattern whose first group is the version. */
const PLACES: { file: string; pattern: RegExp; tag?: boolean }[] = [
  { file: "cli/package.json", pattern: /"version": "([^"]+)"/ },
  { file: "plugin/.claude-plugin/plugin.json", pattern: /"version": "([^"]+)"/ },
  { file: "mod/.claude-plugin/plugin.json", pattern: /"version": "([^"]+)"/ },
  // The hosted page is built from main and reports it in its client header.
  { file: "web/package.json", pattern: /"version": "([^"]+)"/ },
  { file: "mod/hooks/agent.ts", pattern: /export const VERSION = "([^"]+)";/ },
  {
    file: "android/app/build.gradle.kts",
    pattern: /gradleProperty\("versionName"\)\.orNull \?: "([^"]+)"/,
  },
  // Both plugin entries: Claude Code installs them from this tag.
  { file: ".claude-plugin/marketplace.json", pattern: /"ref": "v([^"]+)"/g, tag: true },
];

const isRc = (v: string) => v.includes("-rc.");

/** Each version the pattern finds; `[""]` when it finds none, which check and stamp refuse. */
function found(text: string, pattern: RegExp): string[] {
  const all = pattern.global ? [...text.matchAll(pattern)] : [text.match(pattern)];
  return all.length ? all.map((m) => m?.[1] ?? "") : [""];
}

/** What disagrees with `version`, one line per place; empty when all agree. */
export function check(version?: string, root = ROOT): string[] {
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const want = version ?? (JSON.parse(read("cli/package.json")) as { version: string }).version;
  const wrong: string[] = [];
  for (const { file, pattern, tag } of PLACES)
    for (const v of found(read(file), pattern)) {
      const ok = tag && isRc(want) ? NUMBER.test(v) && !isRc(v) : v === want;
      if (!ok)
        wrong.push(`${file}: ${tag ? "v" : ""}${v || "(none)"}, want ${tag ? "v" : ""}${want}`);
    }
  return wrong;
}

export function stamp(version: string, root = ROOT) {
  if (!NUMBER.test(version)) throw new Error(`not a version: ${version}`);
  for (const { file, pattern, tag } of PLACES) {
    if (tag && isRc(version)) continue;
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    if (found(text, pattern).includes("")) throw new Error(`${file}: no version to stamp`);
    writeFileSync(
      path,
      text.replace(pattern, (m, old: string) => m.replace(old, version)),
    );
  }
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  if (first === "--check") {
    const wrong = check(second);
    for (const line of wrong) console.error(line);
    process.exit(wrong.length ? 1 : 0);
  }
  if (!first) {
    console.error("usage: bun cli/scripts/version.ts <version> | --check [version]");
    process.exit(64);
  }
  stamp(first);
}
