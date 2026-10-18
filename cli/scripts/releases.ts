/**
 * releases.json, the file behind status.starbridge.run/releases (#1618): what each release actually
 * published, written by release.yml at the end of a run.
 *   bun cli/scripts/releases.ts record <file> <version> '<channels json>' [shipped]
 * Records only what a job reports as done, and merges into the version's entry, so a re-run of a failed
 * job fills in what was missing. It holds no commit, rollout, CI state or tester list: the page is public.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { compareVersions, isRc, parseVersion } from "../src/release";

/** Where a release is. GitHub's channel (prerelease or latest) and npm's tag follow from the ring. */
type Channels = {
  /** The GitHub release exists; the desktop app's files are on it when `desktop` is true. */
  github?: true;
  npm?: true;
  homebrew?: true;
  desktop?: true;
  play?: { track: "alpha" | "production"; versionCode: number };
  testflight?: { build: string };
};

export type Entry = {
  version: string;
  ring: "rc" | "final";
  /** When the GitHub release was created, ISO 8601 UTC. */
  shipped: string;
  channels: Channels;
};

export type Releases = { schema: 1; updated: string; releases: Entry[] };

export const ring = (version: string): Entry["ring"] => (isRc(version) ? "rc" : "final");

/** Keeps only the channels this file knows, in a shape it knows, so nothing else can reach a public page. */
export function clean(input: unknown): Channels {
  const c = (input ?? {}) as Record<string, unknown>;
  const out: Channels = {};
  for (const k of ["github", "npm", "homebrew", "desktop"] as const)
    if (c[k] === true) out[k] = true;
  const play = c.play as { track?: unknown; versionCode?: unknown } | undefined;
  if (
    (play?.track === "alpha" || play?.track === "production") &&
    Number.isInteger(play.versionCode)
  )
    out.play = { track: play.track, versionCode: play.versionCode as number };
  const tf = c.testflight as { build?: unknown } | undefined;
  if (typeof tf?.build === "string" && /^[0-9.]+$/.test(tf.build))
    out.testflight = { build: tf.build };
  return out;
}

export function record(
  file: Releases | undefined,
  version: string,
  channels: unknown,
  shipped: string,
  now = new Date().toISOString(),
): Releases {
  if (!parseVersion(version)) throw new Error(`not a version: ${version}`);
  const rest = (file?.releases ?? []).filter((e) => e.version !== version);
  const old = file?.releases.find((e) => e.version === version);
  const merged = { ...old?.channels, ...clean(channels) };
  const entry: Entry = {
    version,
    ring: ring(version),
    shipped: old?.shipped ?? shipped,
    channels: merged,
  };
  const releases = [entry, ...rest].sort((a, b) => compareVersions(b.version, a.version));
  return { schema: 1, updated: now, releases };
}

if (import.meta.main) {
  const [cmd, path, version, json, shipped] = process.argv.slice(2);
  if (cmd !== "record" || !path || !version || !json)
    throw new Error("usage: releases.ts record <file> <version> '<channels json>' [shipped]");
  const old = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Releases) : undefined;
  const next = record(old, version, JSON.parse(json), shipped ?? new Date().toISOString());
  writeFileSync(path, `${JSON.stringify(next, null, 1)}\n`);
}
