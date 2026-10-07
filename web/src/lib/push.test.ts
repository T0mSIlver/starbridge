import { expect, test } from "bun:test";
import { current, sameKey, subscribeFailure } from "./push";

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
