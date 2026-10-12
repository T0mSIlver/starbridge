import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SERVER, serverOrigin } from "./origin";

/**
 * Where the app stays: the menu bar, with a Dock icon only while the window is open (the
 * default); the Dock, always, with no menu bar icon; or both, always.
 */
export type Place = "menu" | "dock" | "both";
export const PLACES: readonly Place[] = ["menu", "dock", "both"];

export const parsePlace = (x: unknown): Place | null =>
  PLACES.includes(x as Place) ? (x as Place) : null;

/** The app's own settings; the page keeps its own, as in a browser. */
export interface Settings {
  /** The server's origin. */
  server: string;
  /** The global shortcut that shows the window, in Electron's accelerator syntax. */
  shortcut: string;
  /** Items already notified, so a restart does not notify them again. */
  notified: string[];
  place: Place;
  /** Whether macOS was asked to allow notifications, which happens once, after sign-in. */
  notificationsAsked: boolean;
  /** Whether updates include release candidates, not only finals (#1071). */
  releaseCandidates: boolean;
  /** The page's last background colour, which the window shows until the page paints. */
  background?: string;
}

/** The app's settings the page's Settings shows (#1449), which the menu bar's menu held before. */
export interface AppSettings {
  /** Whether macOS opens the app at login. */
  login: boolean;
  /** `Settings.releaseCandidates`; null in a development run, which never updates. */
  releaseCandidates: boolean | null;
  /** The server's host. */
  server: string;
  /** The version downloaded, which installs on quit or from Restart; null until there is one. */
  update: string | null;
}

/** One change the page asks for: a switch it turned. */
export type AppChange = { login: boolean } | { releaseCandidates: boolean };

export function parseAppChange(x: unknown): AppChange | null {
  if (typeof x !== "object" || x === null) return null;
  const keys = Object.keys(x);
  const [key] = keys;
  const value = (x as Record<string, unknown>)[key ?? ""];
  if (keys.length !== 1 || typeof value !== "boolean") return null;
  if (key === "login") return { login: value };
  if (key === "releaseCandidates") return { releaseCandidates: value };
  return null;
}

/** A colour the page reports as its background: `#rrggbb` only. */
export const parseBackground = (x: unknown): string | null =>
  typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x) ? x.toLowerCase() : null;

export const DEFAULT_SHORTCUT = "Control+Alt+S";

/** `version` is the running app's: one installed from a release candidate follows them at first. */
export function readSettings(file: string, version = ""): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  const notified = Array.isArray(saved.notified)
    ? saved.notified.filter((id) => typeof id === "string")
    : [];
  return {
    server: (typeof saved.server === "string" && serverOrigin(saved.server)) || DEFAULT_SERVER,
    shortcut: typeof saved.shortcut === "string" ? saved.shortcut : DEFAULT_SHORTCUT,
    notified,
    place: parsePlace(saved.place) ?? "menu",
    // An app from before the setting that notified something has had macOS's question already.
    notificationsAsked:
      typeof saved.notificationsAsked === "boolean"
        ? saved.notificationsAsked
        : notified.length > 0,
    releaseCandidates:
      typeof saved.releaseCandidates === "boolean"
        ? saved.releaseCandidates
        : version.includes("-rc."),
    background: parseBackground(saved.background) ?? undefined,
  };
}

/** Writes a temporary file and renames it, so a crash never leaves half a file. */
export function writeSettings(file: string, s: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${file}.tmp`, file);
}
