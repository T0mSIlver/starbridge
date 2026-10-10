/**
 * Uploads a release's App Bundle to Google Play's Alpha track, the testers' closed track (#1024):
 *   bun run scripts/play.ts <aab> <version> <notes.md> [--validate]
 * PLAY_ACCESS_TOKEN is an OAuth token for the androidpublisher scope; in CI, google-github-actions/auth
 * trades the job's OIDC token for one, so no key exists. --validate checks the edit
 * with Play and discards it, so nothing is published. Without it the edit is committed, which sends
 * it for review; with managed publishing on, it then waits in Play Console for Publish.
 */
import { readFileSync } from "node:fs";

export const PACKAGE = "dev.starbridge.app";
export const TRACK = "alpha";
// Play's limit on one language's release notes.
const NOTES_MAX = 500;

/**
 * The release notes Play shows testers, from the GitHub release's generated notes: one line per
 * pull request title, without the author and link, cut to Play's limit with a link to the rest.
 */
export function playNotes(markdown: string, releaseUrl: string): string {
  const lines = markdown
    .split("\n")
    .filter((l) => /^[*-] /.test(l))
    .map((l) => `• ${l.slice(2).replace(/ by @\S+ in https:\/\/\S+$/, "")}`);
  const more = `More: ${releaseUrl}`;
  if (lines.length === 0) return more;
  const all = lines.join("\n");
  if (all.length <= NOTES_MAX) return all;
  const kept: string[] = [];
  let length = more.length;
  for (const line of lines) {
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
      `${at}/tracks/${TRACK}`,
      JSON.stringify({
        track: TRACK,
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
      await call("POST", `${at}:validate`);
      console.log(
        `Play accepts ${opts.version} (versionCode ${versionCode}) on ${TRACK}; nothing committed.`,
      );
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
    console.log(`Uploaded ${opts.version} (versionCode ${versionCode}) to ${TRACK}.`);
    return versionCode;
  } catch (e) {
    await call("DELETE", at).catch(() => {});
    throw e;
  }
}

class PlayError extends Error {}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const validate = args.includes("--validate");
  const [aab, version, notesPath] = args.filter((a) => a !== "--validate");
  const token = process.env.PLAY_ACCESS_TOKEN;
  if (!aab || !version || !notesPath || !token) {
    throw new Error("usage: PLAY_ACCESS_TOKEN=… play.ts <aab> <version> <notes.md> [--validate]");
  }
  const releaseUrl = `https://github.com/T0mSIlver/starbridge/releases/tag/v${version}`;
  await upload({
    token,
    aab: readFileSync(aab),
    version,
    notes: playNotes(readFileSync(notesPath, "utf8"), releaseUrl),
    validate,
    api: process.env.PLAY_API_URL,
  });
}
