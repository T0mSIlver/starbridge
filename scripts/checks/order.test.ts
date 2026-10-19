// Which snooze or waiting update a client keeps is one rule (PROTOCOL.md, "Snoozing"):
// `laterSnooze` and `laterWaiting`. Clients that compared the two times their own way, as text,
// in whole seconds, or keeping the first to arrive on a tie, disagreed with each other again and
// again (#1981, #1982, #1991, #2103). This fails on a line that compares two such times itself.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const DIRS = [
  "web/src",
  "cli/src",
  "desktop/src",
  "packages/protocol/src",
  "android/app/src/main",
  "ios/Starbridge",
  "ios/Notifications",
];
const SOURCE = /\.(ts|tsx|kt|swift)$/;

function files(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of names) {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) out.push(...files(path));
    else if (SOURCE.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

// A time on each side of a comparison: `had.at < w.at`, `Date.parse(kept.at) >= Date.parse(at)`,
// Swift's `d.waitingAt.flatMap(Dates.parse), kept >= at`, Kotlin's `snoozedAt)?.isBefore(at)`.
const STAMP = String.raw`(?:\.at|[a-z]At|\bat)\b`;
const COMPARED = [
  new RegExp(`${STAMP}[^<>=;]*?(?:<=|>=|<|>)\\s*(?:Date\\.parse\\()?[\\w.?]*${STAMP}`),
  new RegExp(`(?:snoozedAt|waitingAt)\\b.*\\.(?:isBefore|isAfter|compareTo)\\(\\s*\\w*\\b(?:at|At)\\b`),
];

/**
 * Lines that compare two snooze or waiting times without the rule. `order-ok: <why>` on the line or
 * the one before exempts it.
 */
export function offenders(text: string, path: string): string[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) =>
    !/order-ok:/.test(lines[i - 1] ?? "") &&
    /snooz|waiting|had\.at|kept\.at/i.test(line) &&
    COMPARED.some((re) => re.test(line)) &&
    !/later(Snooze|Waiting)|order-ok:|=>/.test(line) &&
    !/^\s*(\/\/|\*|\/\*)/.test(line)
      ? [`${path}:${i + 1}: ${line.trim()}`]
      : [],
  );
}

test("clients compare snooze and waiting times only through laterSnooze and laterWaiting (#2103)", () => {
  const found = DIRS.flatMap(files).flatMap((path) =>
    offenders(readFileSync(join(root, path), "utf8"), path),
  );
  expect(
    found,
    "Compare two snooze or waiting times with laterSnooze/laterWaiting (packages/protocol/src/order.ts; Android data/Order.kt; iOS Order in Data/Inbox.swift), or mark a comparison that is not one of them `order-ok: <why>`",
  ).toEqual([]);
});
