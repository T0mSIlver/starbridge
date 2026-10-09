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
  let presence: unknown = ipcRenderer.sendSync("presence?");
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
  ipcRenderer.on("place", (_e, p: unknown) => {
    place = p;
  });
  // Said back once the page acted on it, so a quitting app knows the server heard the owner left.
  ipcRenderer.on("screen", async (_e, s: unknown) => {
    screen = s;
    try {
      await onScreen?.();
    } catch {}
    ipcRenderer.send("screen-told");
  });
  ipcRenderer.on("presence", (_e, on: unknown) => {
    presence = on;
  });

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
    /** The Mac's reading: `{away, idleMs}`, idleMs null unless `presence()` (src/screen.ts). */
    screen: () => screen,
    /** Called when the reading changes; resolve once the page acted on it. */
    onScreen: (f: (() => Promise<void>) | null) => {
      onScreen = f;
    },
    /** Whether the Mac's idle time counts as presence; off unless the owner turns it on. */
    presence: () => presence,
    setPresence: (on: unknown) => ipcRenderer.send("presence", on),
    /** Opens an item whose notification was clicked. */
    onOpen: (f: (id: string) => void) => {
      onOpen = f;
    },
  });
}
