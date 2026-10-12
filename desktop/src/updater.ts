import { autoUpdater } from "electron-updater";
import { feedTags, pickRelease } from "./releases";

/** How often the app looks for a release; it also looks once at start. */
const UPDATE_MS = 6 * 3_600_000;
const REPO = "T0mSIlver/starbridge";

/**
 * Updates from GitHub Releases: the app reads the release `pickRelease` names, whose
 * latest-mac.yml says the version and the zip. Its own file, which main loads once the window
 * shows: electron-updater is most of the app's code, and nothing at start needs it. macOS installs
 * an update only when it carries the same Developer ID as the running app, so an ad hoc build
 * finds updates and cannot install them; that error is logged, never shown.
 */
export function startUpdates(
  downloaded: (version: string) => void,
  rcs: () => boolean,
): { install(): void; check(): void } {
  autoUpdater.logger = console;
  // The download under way, which turning release candidates off cancels when it is one. One
  // already downloaded stays: Squirrel has taken it, and installs it on quit.
  let pending: { version: string; cancel(): void } | null = null;
  autoUpdater.on("update-downloaded", (info) => {
    pending = null;
    downloaded(info.version);
  });
  autoUpdater.on("error", (e) => console.warn("update:", e.message));
  const check = async () => {
    if (pending?.version.includes("-rc.") && !rcs()) {
      pending.cancel();
      pending = null;
    }
    try {
      // Not the API, whose 60 requests an hour are shared by every machine behind an address.
      const [latest, feed] = await Promise.all([
        fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual" }),
        rcs() ? fetch(`https://github.com/${REPO}/releases.atom`) : null,
      ]);
      const final = /\/releases\/tag\/([^/?#]+)$/.exec(latest.headers.get("location") ?? "")?.[1];
      if (feed && !feed.ok) throw new Error(`GitHub's feed answered ${feed.status}`);
      const tag = pickRelease(final ?? null, feed ? feedTags(await feed.text()) : [], rcs());
      if (!tag) return;
      autoUpdater.setFeedURL({
        provider: "generic",
        url: `https://github.com/${REPO}/releases/download/${tag}/`,
      });
      const result = await autoUpdater.checkForUpdates();
      const token = result?.cancellationToken;
      if (result?.isUpdateAvailable && token) {
        pending = { version: result.updateInfo.version, cancel: () => token.cancel() };
      }
    } catch (e) {
      console.warn("update:", e instanceof Error ? e.message : e);
    }
  };
  // Measured runs (STARBRIDGE_TIMING, test/perf.ts) load the updater, so its memory counts, but
  // keep GitHub out of the numbers.
  if (!process.env.STARBRIDGE_TIMING) {
    check();
    setInterval(check, UPDATE_MS);
  }
  return { install: () => autoUpdater.quitAndInstall(), check };
}
