// Notifications for runs that end (#1064). Runs skip Web Push (PROTOCOL.md, "Push"), so the page
// notifies while open, as it does for quota alerts.
import { switchedOff } from "./notify";
import { runKey, runNote, runsToNotify } from "./runs";
import { readStored, stored, writable } from "./stored";
import type { RunItem } from "./types";

const SHOWN = "starbridge:run-notified";

const tag = (id: string) => `r:${id}`;

/**
 * The notifications this page showed itself, by run id: without a service worker, as in the
 * desktop app, nothing else finds them to close (#1190).
 */
const shownHere = new Map<string, Notification>();

/** Whether a run that ends would notify here: this device's switch on, and the browser's permission. */
export const runAlertsOn = () =>
  !switchedOff() && typeof Notification !== "undefined" && Notification.permission === "granted";

/**
 * Shows one notification, with the system's sound, for each run that passed or failed since
 * the last read, whatever the presence hold, as on Android. The page's first read (`first`)
 * only notes the runs that already ended: they are old news. Tabs share the list, so a run
 * notifies once per browser.
 */
export async function notifyRuns(items: RunItem[], first: boolean): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SHOWN);
  } catch {}
  if (!writable(raw)) return;
  const kept = readStored(SHOWN, raw)?.shown;
  const shown = Array.isArray(kept) ? (kept as string[]) : [];
  const fresh = runsToNotify(items, shown, Date.now());
  if (fresh.length === 0) return;
  try {
    localStorage.setItem(SHOWN, stored({ shown: [...shown, ...fresh.map(runKey)].slice(-200) }));
  } catch {}
  if (first || !runAlertsOn()) return;
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const i of fresh) {
    const { title, body } = runNote(i);
    const opts = { body, tag: tag(i.run.id), silent: false };
    if (reg) await reg.showNotification(title, opts);
    else {
      const n = new Notification(title, opts);
      // A run that ends again under its id replaces its notification, which shares the tag.
      shownHere.set(i.run.id, n);
      n.onclose = () => {
        if (shownHere.get(i.run.id) === n) shownHere.delete(i.run.id);
      };
    }
  }
}

/** Closes a dismissed run's notification, as on Android. */
export async function closeRun(id: string): Promise<void> {
  shownHere.get(id)?.close();
  shownHere.delete(id);
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const n of (await reg?.getNotifications({ tag: tag(id) })) ?? []) n.close();
}
