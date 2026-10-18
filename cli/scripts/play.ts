/**
 * Uploads an App Bundle to Google Play: internal, the owner's builds of main (#1540), Alpha, the
 * testers' closed track (#1024), or production, for a final once Play allows it (#1070):
 *   bun run scripts/play.ts <aab> <version> <notes.md> [--track internal|alpha|production] [--url <link>] [--validate]
 * PLAY_ACCESS_TOKEN is an OAuth token for the androidpublisher scope; in CI, google-github-actions/auth
 * trades the job's OIDC token for one, so no key exists. --validate checks the edit
 * with Play and discards it, so nothing is published; a versionCode no higher than the track's
 * (a dry run from main) is reported, not failed. Without it the edit is committed, which sends
 * it for review; with managed publishing on, it then waits in Play Console for Publish.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseVersion } from "../src/release";

export const PACKAGE = "dev.starbridge.app";
export const TRACKS = ["internal", "alpha", "production"] as const;
export type Track = (typeof TRACKS)[number];
// Play's limit on one language's release notes.
const NOTES_MAX = 500;

/**
 * The release notes Play shows testers: the Android section of the GitHub release's notes
 * (release-notes.ts), cut to Play's limit with a link to the rest.
 */
export function playNotes(markdown: string, releaseUrl: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === "### Android");
  const end = lines.findIndex((l, i) => i > start && /^#{1,6} |^<details>/.test(l));
  const notes = (start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end))
    .filter((l) => /^[*-] /.test(l))
    .map((l) => `• ${l.slice(2).replace(/ \(#\d+\)$/, "")}`);
  const more = `More: ${releaseUrl}`;
  if (notes.length === 0) return more;
  const all = notes.join("\n");
  if (all.length <= NOTES_MAX) return all;
  const kept: string[] = [];
  let length = more.length;
  for (const line of notes) {
    if (length + line.length + 1 > NOTES_MAX) break;
    kept.push(line);
    length += line.length + 1;
  }
  return [...kept, more].join("\n");
}

export async function upload(opts: {
  token: string;
  aab: Uint8Array<ArrayBuffer>;
  version: string;
  notes: string;
  track: Track;
  validate: boolean;
  api?: string;
}): Promise<number> {
  const api = opts.api ?? "https://androidpublisher.googleapis.com";
  const app = `/androidpublisher/v3/applications/${PACKAGE}`;
  async function call<T>(
    method: string,
    path: string,
    body?: BodyInit,
    type = "application/json",
  ): Promise<T> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.token}`, "content-type": type },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new PlayError(`Play ${method} ${path.split("?")[0]}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  const edit = (await call<{ id: string }>("POST", `${app}/edits`)).id;
  const at = `${app}/edits/${edit}`;
  try {
    const { versionCode } = await call<{ versionCode: number }>(
      "POST",
      `/upload${at}/bundles?uploadType=media`,
      opts.aab,
      "application/octet-stream",
    );
    // Notes in the listing's default language, the one every tester falls back to.
    const { defaultLanguage } = await call<{ defaultLanguage: string }>("GET", `${at}/details`);
    await call(
      "PUT",
      `${at}/tracks/${opts.track}`,
      JSON.stringify({
        track: opts.track,
        releases: [
          {
            name: opts.version,
            versionCodes: [String(versionCode)],
            status: "completed",
            releaseNotes: [{ language: defaultLanguage, text: opts.notes }],
          },
        ],
      }),
    );
    if (opts.validate) {
      try {
        await call("POST", `${at}:validate`);
        console.log(
          `Play accepts ${opts.version} (versionCode ${versionCode}) on ${opts.track}; nothing committed.`,
        );
      } catch (e) {
        // A dry run from main carries a versionCode no higher than the track's, which Play refuses to
        // roll out (#1530). The upload and the track edit it got through are what a dry run can check.
        if (
          !(
            e instanceof PlayError &&
            e.message.includes("does not allow any existing users to upgrade")
          )
        )
          throw e;
        console.log(
          `Play took the bundle (versionCode ${versionCode}) and the ${opts.track} release, but would not roll ${opts.version} out: its versionCode is not above the track's. Nothing committed.`,
        );
      }
      await call("DELETE", at);
      return versionCode;
    }
    try {
      await call("POST", `${at}:commit`);
    } catch (e) {
      // Play refuses to send for review on its own while the app has changes it rejected or the
      // owner holds; the edit then waits in Play Console's publishing overview instead.
      if (!(e instanceof PlayError && e.message.includes("changesNotSentForReview"))) throw e;
      await call("POST", `${at}:commit?changesNotSentForReview=true`);
      console.log(
        `::warning::Play would not send ${opts.version} for review; send it from Play Console.`,
      );
    }
    console.log(`Uploaded ${opts.version} (versionCode ${versionCode}) to ${opts.track}.`);
    return versionCode;
  } catch (e) {
    await call("DELETE", at).catch(() => {});
    throw e;
  }
}

/**
 * What the internal track holds (#1540): its release's name, `main-<commit>` for a build of main,
 * and its highest versionCode. internal.yml reads it to skip a commit the track has and to take the
 * next code. Read in an edit that is then discarded.
 */
export async function internalTrack(
  token: string,
  api = "https://androidpublisher.googleapis.com",
) {
  const app = `${api}/androidpublisher/v3/applications/${PACKAGE}`;
  const call = async (method: string, url: string) => {
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) throw new PlayError(`Play ${method} ${url.split("?")[0]}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };
  const edit = (await call("POST", `${app}/edits`)).id as string;
  try {
    const track = (await call("GET", `${app}/edits/${edit}/tracks/internal`)) as {
      releases?: { name?: string; versionCodes?: string[] }[];
    };
    const releases = track.releases ?? [];
    const codes = releases.flatMap((r) => (r.versionCodes ?? []).map(Number));
    return { name: releases[0]?.name ?? "", maxCode: codes.length ? Math.max(...codes) : 0 };
  } finally {
    await call("DELETE", `${app}/edits/${edit}`).catch(() => {});
  }
}

const VERSION_CODE_BASE = 2_000_000;

/**
 * The versionCode of a build of main for the internal track (#1540, #1690): the first of the
 * version's slots 50 to 98 above `after`, the track's highest code, or null once they are spent.
 * The version under way is an rc's own, or the next patch once its final exists: `version` is a
 * final, or `finalTagged` says refs/tags/v<base> exists (#1731). Mirrors mainVersionCodeOf in
 * android/buildSrc/.../VersionCode.kt, which Gradle still enforces.
 */
export function mainCode(version: string, after: number, finalTagged = false): number | null {
  const v = parseVersion(version);
  if (!v) throw new Error(`not a version: ${version}`);
  const patch = v.patch + (v.rc !== undefined && !finalTagged ? 0 : 1);
  const slot0 = VERSION_CODE_BASE + v.major * 1_000_000 + v.minor * 10_000 + patch * 100;
  const first = slot0 + 50;
  const code = Math.max(first, after + 1);
  return code <= slot0 + 98 ? code : null;
}

/** Whether the final of `version`'s base is tagged here, as desktop/scripts/tip.ts reads it. */
export function finalTagged(version: string): boolean {
  const base = version.replace(/-.*/, "");
  return (
    spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/v${base}`], { stdio: "ignore" })
      .status === 0
  );
}

class PlayError extends Error {}

if (import.meta.main && process.argv[2] === "internal-state") {
  // `play.ts internal-state [version]`: the internal track's release name and highest code, as
  // JSON; with the version in package.json, also whether its final is tagged and the code of the
  // next build of main, null when spent.
  const token = process.env.PLAY_ACCESS_TOKEN;
  if (!token) throw new Error("usage: PLAY_ACCESS_TOKEN=… play.ts internal-state");
  const state = await internalTrack(token, process.env.PLAY_API_URL);
  const version = process.argv[3];
  const tagged = version ? finalTagged(version) : false;
  console.log(
    JSON.stringify(
      version ? { ...state, final: tagged, code: mainCode(version, state.maxCode, tagged) } : state,
    ),
  );
} else if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      validate: { type: "boolean" },
      track: { type: "string", default: "alpha" },
      // Where the notes' "More" link goes: the release's page by default.
      url: { type: "string" },
    },
  });
  const [aab, version, notesPath] = positionals;
  const track = values.track as Track;
  const token = process.env.PLAY_ACCESS_TOKEN;
  if (!aab || !version || !notesPath || !token || !TRACKS.includes(track)) {
    throw new Error(
      "usage: PLAY_ACCESS_TOKEN=… play.ts <aab> <version> <notes.md> [--track internal|alpha|production] [--url <link>] [--validate]",
    );
  }
  const releaseUrl =
    values.url ?? `https://github.com/T0mSIlver/starbridge/releases/tag/v${version}`;
  await upload({
    token,
    aab: readFileSync(aab),
    version,
    notes: playNotes(readFileSync(notesPath, "utf8"), releaseUrl),
    track,
    validate: values.validate ?? false,
    api: process.env.PLAY_API_URL,
  });
}
