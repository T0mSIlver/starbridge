// Web Push on the page side: registers the service worker and subscribes with the server's
// VAPID key. The service worker (src/sw/sw.ts) opens what arrives.
import { api } from "./api";
import { desktop } from "./desktop";
import { needsHomeScreen, thisBrowser } from "./install";
import { getPref, setPref } from "./prefs";

/** "install": an iOS tab, where push needs the page on the Home Screen first. */
export type PushState = "unsupported" | "install" | "denied" | "off" | "on";

// The desktop app notifies through its own bridge (lib/desktop.ts), not Web Push.
const supported = () =>
  !desktop &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof PushManager !== "undefined" &&
  typeof Notification !== "undefined";

export function registerWorker(): Promise<ServiceWorkerRegistration> | undefined {
  if (!supported()) return undefined;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function pushState(): Promise<PushState> {
  if (needsHomeScreen(thisBrowser())) return "install";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function send(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  const keys = json.keys as { p256dh?: string; auth?: string } | undefined;
  if (!json.endpoint || !keys?.p256dh || !keys.auth) throw new Error("subscription has no keys");
  await api.subscribe(json.endpoint, { p256dh: keys.p256dh, auth: keys.auth });
}

/**
 * Stops Web Push to this browser (#943): the server forgets its subscription and the browser
 * drops it, so nothing subscribes again at the next boot until the owner turns it back on.
 */
export async function disablePush(): Promise<PushState> {
  setPref("pushOff", true);
  const reg = supported() ? await navigator.serviceWorker.getRegistration("/") : undefined;
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    const json = sub.toJSON();
    const keys = json.keys as { p256dh?: string; auth?: string } | undefined;
    // The server returns a known endpoint's id when it is sent again.
    if (json.endpoint && keys?.p256dh && keys.auth) {
      const { id } = await api.subscribe(json.endpoint, { p256dh: keys.p256dh, auth: keys.auth });
      await api.unsubscribe(id);
    }
    await sub.unsubscribe();
  }
  return pushState();
}

/** Asks for permission (call it from a click) and subscribes this device. */
export async function enablePush(): Promise<PushState> {
  setPref("pushOff", false);
  const reg = await registerWorker();
  if (!reg) return "unsupported";
  if ((await Notification.requestPermission()) !== "granted") return pushState();
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  // Without the server's key, an existing subscription is still worth sending.
  const key = await api.vapid().catch((e) => {
    if (existing) return undefined;
    throw e;
  });
  let sub: PushSubscription;
  try {
    sub = await current(reg.pushManager, existing, key);
  } catch (e) {
    throw new Error(subscribeFailure(e));
  }
  await send(sub);
  return "on";
}

/**
 * The subscription to send: the existing one while the server's key made it, else a new one. A
 * push service refuses pushes signed with another key than the subscription's, as when a server
 * moves from the relay to its own VAPID keys (#567).
 */
export async function current(
  pm: Pick<PushManager, "subscribe">,
  existing: PushSubscription | null,
  key: string | undefined,
): Promise<PushSubscription> {
  if (existing && (!key || sameKey(existing.options.applicationServerKey, keyBytes(key))))
    return existing;
  if (!key) throw new Error("the server has no Web Push key");
  // A browser keeps one subscription per worker, so the old one goes first.
  await existing?.unsubscribe().catch(() => {});
  return pm.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
}

/** Whether a subscription's key is `key`. A browser that doesn't report it counts as a match. */
export function sameKey(subscribed: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!subscribed) return true;
  const a = new Uint8Array(subscribed);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/** What to tell the owner when the browser's push service refuses to subscribe. */
export function subscribeFailure(e: unknown, brave = "brave" in navigator): string {
  if (brave)
    return 'Brave blocks web push by default. Turn on "Use Google services for push messaging" in brave://settings/privacy, restart Brave, then try again.';
  const why = e instanceof Error ? e.message : String(e);
  return `The browser could not subscribe to push: ${why}. Check that notifications and push messaging are allowed for this site, then try again.`;
}

/**
 * Sends the current subscription again, so a server that dropped it pushes here once more, after
 * a new one if the server's key changed.
 */
export async function resubscribe(): Promise<void> {
  if (!supported() || Notification.permission !== "granted" || getPref("pushOff")) return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const existing = await reg?.pushManager.getSubscription();
  if (!reg || !existing) return;
  const key = await api.vapid().catch(() => undefined);
  const sub = await current(reg.pushManager, existing, key);
  // Turned off while the key was read (#943): what a new key subscribed goes too.
  if (getPref("pushOff")) {
    await sub.unsubscribe();
    return;
  }
  await send(sub);
}
