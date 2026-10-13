import { autoUpdater, type CancellationToken } from "electron-updater";
import { feedTags, pickRelease } from "./releases";
import { type UpdateSettings, type UpdateStatus, Updates } from "./updates";

/** How often the app looks for a release; it also looks once at start. */
const UPDATE_MS = 6 * 3_600_000;

/**
 * Updates from GitHub Releases: the app reads the release `pickRelease` names, whose
 * latest-mac.yml says the version and the zip. Its own file, which main loads once the window
 * shows: electron-updater is most of the app's code, and nothing at start needs it. macOS installs
 * an update only when it carries the same Developer ID as the running app, so an ad hoc build
 * downloads updates and never installs them: Squirrel's refusal comes after the download, and is
 * logged. `releases` is the repository's page,
 * https://github.com/T0mSIlver/starbridge but in the end-to-end test (test/smoke.ts).
 */
export function startUpdates(
  releases: string,
  settings: () => UpdateSettings,
  tell: (s: UpdateStatus) => void,
): Updates {
  autoUpdater.logger = console;
  // The flow downloads when the owner's setting says so (src/updates.ts).
  autoUpdater.autoDownload = false;
  // Unpackaged, only the end-to-end test runs the updater.
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.on("error", (e) => console.warn("update:", e.message));
  let token: CancellationToken | null = null;
  const updates = new Updates(
    {
      async find(rcs) {
        // Not the API, whose 60 requests an hour are shared by every machine behind an address.
        const [latest, feed] = await Promise.all([
          fetch(`${releases}/releases/latest`, { redirect: "manual" }),
          rcs ? fetch(`${releases}/releases.atom`) : null,
        ]);
        const final = /\/releases\/tag\/([^/?#]+)$/.exec(latest.headers.get("location") ?? "")?.[1];
        if (feed && !feed.ok) throw new Error(`GitHub's feed answered ${feed.status}`);
        const tag = pickRelease(final ?? null, feed ? feedTags(await feed.text()) : [], rcs);
        if (!tag) return null;
        // Each check points the updater at the tag it picked, so a download fetches the release
        // the last check offered, even after an older one was downloaded (#1444).
        autoUpdater.setFeedURL({
          provider: "generic",
          url: `${releases}/releases/download/${tag}/`,
        });
        const result = await autoUpdater.checkForUpdates();
        if (!result?.isUpdateAvailable || !result.cancellationToken) return null;
        token = result.cancellationToken;
        return result.updateInfo.version;
      },
      download(progress) {
        const onProgress = (p: { percent: number }) => progress(p.percent);
        autoUpdater.on("download-progress", onProgress);
        const t = token ?? undefined;
        const done = autoUpdater
          .downloadUpdate(t)
          .then(() => {})
          .finally(() => autoUpdater.off("download-progress", onProgress));
        return { done, cancel: () => t?.cancel() };
      },
      install: () => autoUpdater.quitAndInstall(),
    },
    settings,
    tell,
  );
  // Measured runs (STARBRIDGE_TIMING, test/perf.ts) load the updater, so its memory counts, but
  // keep GitHub out of the numbers.
  if (!process.env.STARBRIDGE_TIMING) {
    updates.check();
    setInterval(() => updates.check(), UPDATE_MS);
  }
  return updates;
}
