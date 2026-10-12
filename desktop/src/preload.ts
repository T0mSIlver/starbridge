import { contextBridge, ipcRenderer } from "electron";

/**
 * The bridge the server's page uses, `window.starbridgeDesktop`. Only the configured server's
 * origin gets it, and it carries data only: the main process checks the sender and every field
 * again, so a page that got here some other way gains nothing.
 */
function arg(name: string): string | undefined {
  const prefix = `--starbridge-${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

type Answer = { id: string; choice: string } | { id: string; text: string };

if (location.origin === arg("origin")) {
  let onAnswer: ((a: Answer) => Promise<void>) | null = null;
  let onOpen: ((id: string) => void) | null = null;
  // Asked, not passed as an argument: the window's arguments stay as they were at its creation.
  let place: unknown = ipcRenderer.sendSync("place?");
  let screen: unknown = ipcRenderer.sendSync("screen?");
  let onScreen: (() => Promise<void>) | null = null;

  ipcRenderer.on("answer", async (_e, a: Answer) => {
    let error: string | undefined;
    try {
      if (!onAnswer) throw new Error("Starbridge is still loading.");
      await onAnswer(a);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    ipcRenderer.send("answered", { id: a.id, error });
  });
  ipcRenderer.on("open", (_e, id: string) => onOpen?.(id));
  let blocked = ipcRenderer.sendSync("blocked?") === true;
  let onBlocked: (() => void) | null = null;
  ipcRenderer.on("blocked", (_e, b: unknown) => {
    blocked = b === true;
    onBlocked?.();
  });
  let shown = ipcRenderer.sendSync("shown?") !== false;
  let onShown: (() => void) | null = null;
  ipcRenderer.on("shown", (_e, s: unknown) => {
    shown = s === true;
    onShown?.();
  });
  // The updater's state and settings (#1398): the app checks them, so they pass as they come.
  let updateStatus: unknown = ipcRenderer.sendSync("update-status?");
  let updateSettings: unknown = ipcRenderer.sendSync("update-settings?");
  let onUpdate: (() => void) | null = null;
  ipcRenderer.on("update-status", (_e, s: unknown) => {
    updateStatus = s;
    onUpdate?.();
  });
  ipcRenderer.on("update-settings", (_e, s: unknown) => {
    updateSettings = s;
    onUpdate?.();
  });
  let login = ipcRenderer.sendSync("login?") === true;
  let onLogin: (() => void) | null = null;
  ipcRenderer.on("login", (_e, l: unknown) => {
    login = l === true;
    onLogin?.();
  });
  const server: unknown = ipcRenderer.sendSync("server?");
  let onSettings: (() => void) | null = null;
  // Settings… in the menu bar's menu: the page routes there itself, else (an older page) loads it.
  ipcRenderer.on("settings", () => {
    if (onSettings) onSettings();
    else location.assign("/settings");
  });
  ipcRenderer.on("place", (_e, p: unknown) => {
    place = p;
  });
  // Said back once the page acted on it, so a quitting app knows the server heard the owner left.
  ipcRenderer.on("screen", async (_e, s: unknown, n: unknown) => {
    screen = s;
    try {
      await onScreen?.();
    } catch {}
    ipcRenderer.send("screen-told", n);
  });

  // The page's background, for the window to show under it: told at load and when the theme
  // changes, by the Colours setting or the system's.
  const background = () =>
    ipcRenderer.send(
      "background",
      getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    );
  addEventListener("DOMContentLoaded", () => {
    background();
    new MutationObserver(background).observe(document.documentElement, {
      attributeFilter: ["data-theme"],
    });
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", background);

  contextBridge.exposeInMainWorld("starbridgeDesktop", {
    version: arg("version"),
    /** "inset" when the window has no title bar, and the page leaves room for its buttons. */
    titleBar: arg("titlebar"),
    /** The Needs-you count and the items to notify; send it whenever either changes. */
    update: (state: unknown) => ipcRenderer.send("state", state),
    /** Sends a notification's answer; reject with the reason it was not sent. */
    onAnswer: (f: (a: Answer) => Promise<void>) => {
      onAnswer = f;
    },
    /** Where the app stays: "menu" (the menu bar, the default), "dock" or "both". */
    place: () => place,
    setPlace: (p: unknown) => ipcRenderer.send("place", p),
    /** The Mac's reading: `{away, idleMs}` (src/screen.ts). */
    screen: () => screen,
    /** Called when the reading changes; resolve once the page acted on it. */
    onScreen: (f: (() => Promise<void>) | null) => {
      onScreen = f;
    },
    /** Whether the window is on screen, which `document.visibilityState` does not say here. */
    shown: () => shown,
    /** Called when the window shows or hides. */
    onShown: (f: (() => void) | null) => {
      onShown = f;
    },
    /** Whether macOS refused the last notification, as it does while it blocks the app's. */
    notificationsBlocked: () => blocked,
    /** Called when that changes. */
    onNotificationsBlocked: (f: (() => void) | null) => {
      onBlocked = f;
    },
    /** Opens System Settings → Notifications → Starbridge. */
    openNotificationSettings: () => ipcRenderer.send("notification-settings"),
    /**
     * Where the update stands: `{state}` with "idle", "checking", "available", "downloading",
     * "ready" or "error", and its `version`, `percent` or `message` (src/updates.ts). Null while
     * the app runs no updater.
     */
    updateStatus: () => updateStatus,
    /** `{releaseCandidates, autoDownload}`. */
    updateSettings: () => updateSettings,
    setUpdateSettings: (s: unknown) => ipcRenderer.send("update-settings", s),
    /** "check", "download", or "install", which restarts the app. */
    updateAction: (a: unknown) => ipcRenderer.send("update-action", a),
    /** Called when the status or the settings change. */
    onUpdate: (f: (() => void) | null) => {
      onUpdate = f;
    },
    /** Whether macOS opens the app at login. */
    login: () => login,
    setLogin: (l: unknown) => ipcRenderer.send("login", l),
    onLogin: (f: (() => void) | null) => {
      onLogin = f;
    },
    /** The server's host; the app restarts on another. */
    server: () => server,
    /** Opens the window where the owner sets the server. */
    openServer: () => ipcRenderer.send("open-server"),
    /** Called on Settings… in the menu bar's menu, to show the page's Settings. */
    onSettings: (f: (() => void) | null) => {
      onSettings = f;
    },
    /** Opens an item whose notification was clicked. */
    onOpen: (f: (id: string) => void) => {
      onOpen = f;
    },
  });
}
