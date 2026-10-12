import { expect, test } from "bun:test";
import { current, pushState, sameKey, subscribeFailure, subscription } from "./push";

const error = new DOMException("Registration failed - push service error", "AbortError");

test("Brave's push failure names the setting to turn on", () => {
  expect(subscribeFailure(error, true)).toContain("brave://settings/privacy");
});

test("other push failures show the browser's message with a hint", () => {
  const text = subscribeFailure(error, false);
  expect(text).toContain("Registration failed - push service error");
  expect(text).toContain("allowed for this site");
});

const relayKey = "BA".padEnd(87, "A");
const ownKey = "BB".padEnd(87, "B");
// Base64url keys of A and B only, so atob reads them once padded.
const bytes = (k: string) => Uint8Array.from(atob(`${k}=`), (c) => c.charCodeAt(0));

function fakeSub(key: string) {
  const sub = {
    options: { applicationServerKey: bytes(key).buffer },
    unsubscribed: false,
    unsubscribe: async () => {
      sub.unsubscribed = true;
      return true;
    },
  };
  return sub;
}

function fakeManager() {
  const made: Uint8Array[] = [];
  return {
    made,
    subscribe: async (o?: PushSubscriptionOptionsInit) => {
      made.push(new Uint8Array(o?.applicationServerKey as ArrayBuffer));
      return fakeSub(relayKey) as unknown as PushSubscription;
    },
  };
}

test("a subscription made with the server's key is kept", async () => {
  const pm = fakeManager();
  const existing = fakeSub(ownKey);
  const sub = await current(pm, existing as unknown as PushSubscription, ownKey);
  expect(sub).toBe(existing as unknown as PushSubscription);
  expect(existing.unsubscribed).toBe(false);
  expect(pm.made).toEqual([]);
});

test("a subscription made with another key is replaced by one with the server's (#567)", async () => {
  const pm = fakeManager();
  const existing = fakeSub(relayKey);
  const sub = await current(pm, existing as unknown as PushSubscription, ownKey);
  expect(sub).not.toBe(existing as unknown as PushSubscription);
  expect(existing.unsubscribed).toBe(true);
  expect(pm.made).toHaveLength(1);
  expect(pm.made[0]).toEqual(bytes(ownKey));
});

test("with none left, as after Safari dropped it (#1363), a subscription is made with the server's key", async () => {
  const pm = fakeManager();
  await current(pm, null, ownKey);
  expect(pm.made).toEqual([bytes(ownKey)]);
});

test("without the server's key, an existing subscription is kept", async () => {
  const pm = fakeManager();
  const existing = fakeSub(relayKey);
  expect(await current(pm, existing as unknown as PushSubscription, undefined)).toBe(
    existing as unknown as PushSubscription,
  );
  await expect(current(pm, null, undefined)).rejects.toThrow("no Web Push key");
});

test("a browser that doesn't report the subscription's key keeps it", () => {
  expect(sameKey(null, bytes(ownKey))).toBe(true);
  expect(sameKey(bytes(ownKey).buffer, bytes(ownKey))).toBe(true);
  expect(sameKey(bytes(relayKey).buffer, bytes(ownKey))).toBe(false);
});

type Reg = { active: object | null; pushManager: { getSubscription(): Promise<object | null> } };
const reg = (active: boolean, sub: object | null): Reg => ({
  active: active ? {} : null,
  pushManager: { getSubscription: async () => sub },
});
const container = (found: Reg | undefined, ready: Promise<Reg>) =>
  ({ getRegistration: async () => found, ready }) as unknown as Pick<
    ServiceWorkerContainer,
    "getRegistration" | "ready"
  >;

test("a subscription read before the worker is active is read again once it is (#1362)", async () => {
  const sub = {};
  let activate = (_: Reg) => {};
  const ready = new Promise<Reg>((done) => {
    activate = done;
  });
  // At an iOS cold start the registration is there, but no worker is active yet.
  const read = subscription(container(reg(false, null), ready), 60_000);
  activate(reg(true, sub));
  expect(await read).toBe(sub as PushSubscription);
});

test("a page with no worker reads no subscription after the wait, not never", async () => {
  const never = new Promise<Reg>(() => {});
  expect(await subscription(container(undefined, never), 10)).toBeNull();
});

test("an active worker without a subscription reads none at once", async () => {
  const never = new Promise<Reg>(() => {});
  expect(await subscription(container(reg(true, null), never), 60_000)).toBeNull();
});

test("a subscribed iOS window that reads permission as default is on (#1362)", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = ["Notification", "PushManager", "matchMedia"].map((k) => [k, g[k]] as const);
  const sw = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const sub = {};
  try {
    // What a window opened by a notification's tap reads in a Home Screen app.
    g.Notification = { permission: "default" };
    g.PushManager = class {};
    g.matchMedia = () => ({ matches: true });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: container(reg(true, sub), Promise.resolve(reg(true, sub))),
    });
    expect(await pushState()).toBe("on");
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: container(reg(true, null), Promise.resolve(reg(true, null))),
    });
    expect(await pushState()).toBe("off");
    g.Notification = { permission: "denied" };
    expect(await pushState()).toBe("denied");
  } finally {
    for (const [k, v] of saved) g[k] = v;
    if (sw) Object.defineProperty(navigator, "serviceWorker", sw);
    else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  }
});
