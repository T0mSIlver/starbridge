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

export type DesktopAnswer = { id: string; choice: string } | { id: string; text: string };

/** Where the app stays (desktop/src/settings.ts). */
export type DesktopPlace = "menu" | "dock" | "both";

/**
 * The Mac's own reading (#945): away while it is locked, asleep or the app quits, and the seconds
 * since its last input once the owner turned presence on. Only the bit it makes leaves the Mac.
 */
export type DesktopScreen = { away: boolean; idleMs: number | null };

export type DesktopBridge = {
  version: string;
  /** Absent before the app's 0.1.3. */
  place?(): DesktopPlace;
  setPlace?(place: DesktopPlace): void;
  /** "inset" in a window with no title bar (read before the first paint, lib/themeScript.ts). */
  titleBar?: string;
  /** Absent before the app's 0.1.3, as are the three after it. */
  screen?(): DesktopScreen | null;
  /** Called when the reading changes; the app waits for the promise before it quits. */
  onScreen?(f: (() => Promise<void>) | null): void;
  /** Whether the Mac's idle time counts as presence (Settings, off by default). */
  presence?(): boolean;
  setPresence?(on: boolean): void;
  update(state: { count: number; entries: DesktopEntry[] }): void;
  onAnswer(f: (a: DesktopAnswer) => Promise<void>): void;
  onOpen(f: (id: string) => void): void;
};

// globalThis, not window: the service worker reads this module too, and has none.
export const desktop = (globalThis as { starbridgeDesktop?: DesktopBridge }).starbridgeDesktop;
