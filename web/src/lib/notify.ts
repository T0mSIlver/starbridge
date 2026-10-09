// This device's notifications (#943): each device turns only its own on or off, and says which,
// so every device's Devices list shows them all.
import type { NotifyState } from "@starbridge/protocol";
import { api } from "./api";
import { desktop } from "./desktop";
import { getPref } from "./prefs";
import type { PushState } from "./push";

/** What this device reports: the desktop app its own switch, a browser its push state. */
export function reported(push: PushState): NotifyState | undefined {
  if (desktop) return getPref("desktopNotify") ? "on" : "off";
  return { on: "on", denied: "blocked", off: "off", install: "off", unsupported: undefined }[
    push
  ] as NotifyState | undefined;
}

/** Tells the server this device's state; a server without the route has no list to fill. */
export async function report(): Promise<void> {
  const state = reported(await (await import("./push")).pushState());
  if (state) await api.setNotifications(state).catch(() => {});
}
