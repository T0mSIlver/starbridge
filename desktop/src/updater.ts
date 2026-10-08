import { autoUpdater } from "electron-updater";

/** How often the app looks for a release; it also looks once at start. */
const UPDATE_MS = 6 * 3_600_000;

/**
 * Updates from GitHub Releases (electron-updater reads the latest release's latest-mac.yml). Its
 * own file, which main loads once the window shows: electron-updater is most of the app's code,
 * and nothing at start needs it. macOS installs an update only when it carries the same Developer
 * ID as the running app, so an ad hoc build finds updates and cannot install them; that error is
 * logged, never shown.
 */
export function startUpdates(downloaded: () => void): { install(): void } {
  autoUpdater.logger = console;
  autoUpdater.on("update-downloaded", downloaded);
  autoUpdater.on("error", (e) => console.warn("update:", e.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_MS);
  return { install: () => autoUpdater.quitAndInstall() };
}
