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
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

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

class PlayError extends Error {}

if (import.meta.main) {
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
  const releaseUrl = values.url ?? `https://github.com/T0mSIlver/starbridge/releases/tag/v${version}`;
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
