// The service worker's push handler, run against a stub worker scope and a fake IndexedDB.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import * as store from "./lib/store";

type Listener = (e: { data?: { text(): string }; waitUntil(p: Promise<unknown>): void }) => void;
const listeners = new Map<string, Listener>();
const shown: string[] = [];
Object.assign(globalThis, {
  self: {
    addEventListener: (type: string, f: Listener) => listeners.set(type, f),
    registration: {
      showNotification: async (title: string) => void shown.push(title),
      getNotifications: async () => [],
    },
    clients: { matchAll: async () => [] },
  },
});
// A variable path, so the page's typecheck leaves the worker's own lib alone.
const worker = "./sw/sw.ts";
await import(worker);

async function push(payload: object): Promise<void> {
  const onPush = listeners.get("push");
  if (!onPush) throw new Error("the worker listens for no push");
  let done: Promise<unknown> = Promise.resolve();
  onPush({
    data: { text: () => JSON.stringify(payload) },
    waitUntil: (p) => {
      done = p;
    },
  });
  await done;
}

test("a join request shows only on a device of the account the browser is signed in to", async () => {
  // Signed out: no current account.
  await push({ v: 1, kind: "join", id: "j1" });
  // Signed in to an account this browser is not a device of, as after a sign-out and a sign-in
  // to another account while the server still holds the endpoint under the first one (#1230).
  await store.put("current", "acct_other");
  await push({ v: 1, kind: "join", id: "j2" });
  expect(shown).toEqual([]);
});
