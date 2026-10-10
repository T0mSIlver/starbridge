/**
 * The one Starbridge version, stamped into every place that carries it.
 *
 *   bun cli/scripts/version.ts <version>          stamp it, for the release commit the tag points at,
 *                                                 and pin CodexBar's latest release (codexbar-pin.ts)
 *   bun cli/scripts/version.ts --check [version]  fail unless every place says it (default: the CLI's)
 *   bun cli/scripts/version.ts --final <version>  fail unless HEAD is its newest rc tag plus the stamp
 *
 * A release candidate moves every version but leaves the marketplace on the last release, so
 * only users who pin an rc get its plugins.
 */
import { spawnSync } from "node:child_process";
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
  // The desktop app compares it with the release's latest-mac.yml to update.
  { file: "desktop/package.json", pattern: /"version": "([^"]+)"/ },
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

/**
 * The changed files that are not version places: a final release must ship what its rc shipped,
 * which the owner installed and tried (#1004), so only the stamp may differ.
 */
export function beyondStamp(changed: string[]): string[] {
  const stamped = new Set(PLACES.map((p) => p.file));
  return changed.filter((f) => !stamped.has(f));
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

/** The newest `v<version>-rc.N` tag, if any. */
function newestRc(version: string): string | undefined {
  return git("tag", "-l", `v${version}-rc.*`, "--sort=-v:refname")[0];
}

function git(...args: string[]): string[] {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  if (first === "--check") {
    const wrong = check(second);
    for (const line of wrong) console.error(line);
    process.exit(wrong.length ? 1 : 0);
  }
  if (first === "--final") {
    if (!second || !NUMBER.test(second) || isRc(second)) {
      console.error(`--final takes a release version, not ${second ?? "nothing"}`);
      process.exit(64);
    }
    const rc = newestRc(second);
    if (!rc) {
      console.error(`no v${second}-rc.N tag: cut a release candidate and try its APK first`);
      process.exit(1);
    }
    const extra = beyondStamp(git("diff", "--name-only", rc, "HEAD"));
    if (extra.length) {
      console.error(
        `${extra.length} files changed since ${rc}, such as ${extra.slice(0, 5).join(", ")}.`,
      );
      console.error(`Cut the next rc from this commit and try it first.`);
    }
    process.exit(extra.length ? 1 : 0);
  }
  if (!first) {
    console.error(
      "usage: bun cli/scripts/version.ts <version> | --check [version] | --final <version>",
    );
    process.exit(64);
  }
  stamp(first);
  // A final release ships its rc's CodexBar, the one the owner tried.
  const rc = isRc(first) ? undefined : newestRc(first);
  if (rc) {
    console.log(`Kept the CodexBar pin of ${rc}.`);
  } else {
    // Loaded here, not at the top: the release's --check runs before any install.
    const { pinCodexbar } = await import("./codexbar-pin");
    const pin = await pinCodexbar();
    console.log(`Pinned CodexBar ${pin.version}: check that no open \`codexbar\` issue names it.`);
  }
}
