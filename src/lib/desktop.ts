// The desktop app's bridge (desktop/README.md, "The bridge"): present only when this page runs in
// the app, on the server the app is set to. The page hands it the Needs-you count and what to
// notify, and answers what the owner sends from a notification (#886).

/** One item to notify, as `desktop/src/bridge.ts` reads it. */
export type DesktopEntry = {
  id: string;
  title: string;
  body: string;
  options: string[];
  reply: boolean;
  waiting: boolean;
};

/** The most entries the app reads (desktop/src/bridge.ts); older apps refuse a longer list (#1279). */
export const DESKTOP_MAX_ENTRIES = 200;

export type DesktopAnswer = { id: string; choice: string } | { id: string; text: string };

/** Where the app stays (desktop/src/settings.ts). */
export type DesktopPlace = "menu" | "dock" | "both";

/**
 * The Mac's own reading (#945): away while it is locked, asleep or the app quits, and the seconds
 * since its last input. Only the bit it makes leaves the Mac.
 */
export type DesktopScreen = { away: boolean; idleMs: number | null };

/** Where the app's update stands (desktop/src/updates.ts, #1398). */
export type DesktopUpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

/** Where the app's updates come from (desktop/src/releases.ts, #1692). */
export type DesktopChannel = "stable" | "rc" | "tip";

/**
 * `channel` and `ahead` (the installed version waits for the channel to pass it) are absent
 * before #1692, whose apps have the `releaseCandidates` switch only.
 */
export type DesktopUpdateSettings = {
  releaseCandidates: boolean;
  autoDownload: boolean;
  channel?: DesktopChannel;
  ahead?: boolean;
};

export type DesktopBridge = {
  version: string;
  /** Absent before the app's 0.1.3. */
  place?(): DesktopPlace;
  setPlace?(place: DesktopPlace): void;
  /** "inset" in a window with no title bar (read before the first paint, lib/themeScript.ts). */
  titleBar?: string;
  /** Absent before the app's 0.1.3, as is the one after it. */
  screen?(): DesktopScreen | null;
  /** Called when the reading changes; the app waits for the promise before it quits. */
  onScreen?(f: (() => Promise<void>) | null): void;
  /** `waiting` and `account` feed the app's widget (#1031); apps before it ignore them. */
  update(state: {
    count: number;
    waiting: number;
    account: "ready" | "signedOut" | "loading";
    entries: DesktopEntry[];
  }): void;
  /** Absent in older apps. */
  shown?(): boolean;
  onShown?(f: (() => void) | null): void;
  /** Whether macOS refused the last notification (#1069); absent in older apps. */
  notificationsBlocked?(): boolean;
  onNotificationsBlocked?(f: (() => void) | null): void;
  /** Opens System Settings → Notifications → Starbridge. */
  openNotificationSettings?(): void;
  /** Null while the app runs no updater (a development run); absent before #1398. */
  updateStatus?(): DesktopUpdateStatus | null;
  updateSettings?(): DesktopUpdateSettings | null;
  setUpdateSettings?(s: Partial<DesktopUpdateSettings>): void;
  /** "install" restarts the app. */
  updateAction?(a: "check" | "download" | "install"): void;
  /** Called when the status or the settings change. */
  onUpdate?(f: (() => void) | null): void;
  /** Whether macOS opens the app at login; absent before #1449, whose app kept it in its menu. */
  login?(): boolean;
  setLogin?(login: boolean): void;
  onLogin?(f: (() => void) | null): void;
  /** Opens the app's window for setting the server; the app restarts on a new one. */
  openServer?(): void;
  /** Called on Settings… in the menu bar's menu. */
  onSettings?(f: (() => void) | null): void;
  onAnswer(f: (a: DesktopAnswer) => Promise<void>): void;
  onOpen(f: (id: string) => void): void;
};

// globalThis, not window: the service worker reads this module too, and has none.
export const desktop = (globalThis as { starbridgeDesktop?: DesktopBridge }).starbridgeDesktop;
