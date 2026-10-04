// Web Push on the page side: registers the service worker and subscribes with the server's
// VAPID key. The service worker (src/sw/sw.ts) opens what arrives.
import { api } from "./api";

export type PushState = "unsupported" | "denied" | "off" | "on";

const supported = () =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof PushManager !== "undefined" &&
  typeof Notification !== "undefined";

export function registerWorker(): Promise<ServiceWorkerRegistration> | undefined {
  if (!supported()) return undefined;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function pushState(): Promise<PushState> {
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

/** Asks for permission (call it from a click) and subscribes this device. */
export async function enablePush(): Promise<PushState> {
  const reg = await registerWorker();
  if (!reg) return "unsupported";
  if ((await Notification.requestPermission()) !== "granted") return pushState();
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const key = existing ? undefined : keyBytes(await api.vapid());
  let sub: PushSubscription;
  try {
    sub =
      existing ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  } catch (e) {
    throw new Error(subscribeFailure(e));
  }
  await send(sub);
  return "on";
}

/** What to tell the owner when the browser's push service refuses to subscribe. */
export function subscribeFailure(e: unknown, brave = "brave" in navigator): string {
  if (brave)
    return 'Brave blocks web push by default. Turn on "Use Google services for push messaging" in brave://settings/privacy, restart Brave, then try again.';
  const why = e instanceof Error ? e.message : String(e);
  return `The browser could not subscribe to push: ${why}. Check that notifications and push messaging are allowed for this site, then try again.`;
}

/** Sends the current subscription again, so a server that dropped it pushes here once more. */
export async function resubscribe(): Promise<void> {
  if (!supported() || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await send(sub);
}
