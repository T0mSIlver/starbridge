/**
 * Replaces the Play listing's icon and feature graphic (default language en-US) through the Play
 * Developer API, for when Play Console's "Send changes for review" fails with an HTTP 400 and no
 * reason (#1436):
 *   PLAY_ACCESS_TOKEN=… bun run scripts/play-listing.ts <dir>
 * <dir> holds icon-512.png and feature-1024x500.png (android/store/). The edit is committed, which
 * sends it for review; managed publishing is off, so Play publishes it once it approves. A failure
 * prints the API's error body, which Play Console hides.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE } from "./play";

export const IMAGES = [
  { type: "icon", file: "icon-512.png" },
  { type: "featureGraphic", file: "feature-1024x500.png" },
] as const;

export async function updateListing(opts: {
  token: string;
  dir: string;
  language?: string;
  api?: string;
}): Promise<void> {
  const api = opts.api ?? "https://androidpublisher.googleapis.com";
  const language = opts.language ?? "en-US";
  const app = `/androidpublisher/v3/applications/${PACKAGE}`;
  async function call<T>(method: string, path: string, body?: BodyInit, type?: string): Promise<T> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(type ? { "content-type": type } : {}),
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Play ${method} ${path.split("?")[0]}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  const edit = (await call<{ id: string }>("POST", `${app}/edits`)).id;
  const at = `${app}/edits/${edit}`;
  try {
    for (const { type, file } of IMAGES) {
      await call("DELETE", `${at}/listings/${language}/${type}`);
      await call(
        "POST",
        `/upload${at}/listings/${language}/${type}?uploadType=media`,
        readFileSync(join(opts.dir, file)),
        "image/png",
      );
      console.log(`Replaced ${type} for ${language}.`);
    }
    await call("POST", `${at}:commit`);
    console.log("Committed; Play now reviews the listing.");
  } catch (e) {
    await call("DELETE", at).catch(() => {});
    throw e;
  }
}

if (import.meta.main) {
  const token = process.env.PLAY_ACCESS_TOKEN;
  const dir = process.argv[2];
  if (!token || !dir) throw new Error("usage: PLAY_ACCESS_TOKEN=… play-listing.ts <dir>");
  await updateListing({ token, dir, api: process.env.PLAY_API_URL });
}
