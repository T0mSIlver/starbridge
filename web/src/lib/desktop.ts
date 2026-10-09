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

export type DesktopBridge = {
  version: string;
  update(state: { count: number; entries: DesktopEntry[] }): void;
  onAnswer(f: (a: DesktopAnswer) => Promise<void>): void;
  onOpen(f: (id: string) => void): void;
};

// globalThis, not window: the service worker reads this module too, and has none.
export const desktop = (globalThis as { starbridgeDesktop?: DesktopBridge }).starbridgeDesktop;
