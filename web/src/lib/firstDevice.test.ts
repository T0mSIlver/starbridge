// The first device's setup against the real server: its account has no directory yet.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeServer } from "@starbridge/server/test-support";
import { api } from "./api";
import * as device from "./device";

let http: ReturnType<typeof Bun.serve>;
let account: string;
const realFetch = globalThis.fetch;
const realGenerateKey = crypto.subtle.generateKey;

beforeAll(async () => {
  // A bare server: unlike LiveServer's, its account has no device yet.
  const s = await makeServer();
  http = Bun.serve({ port: 0, fetch: (req, server) => s.app.fetch(req, { server }) });
  let cookie = "";
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const res = await realFetch(`http://localhost:${http.port}${input}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), cookie },
    });
    cookie = res.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return res;
  }) as typeof fetch;
  crypto.subtle.generateKey = (() =>
    Promise.reject(new Error("no WebCrypto keys"))) as typeof crypto.subtle.generateKey;
  await api.ownerSignIn("owner-secret");
  ({ account } = await api.me());
});
afterAll(() => {
  globalThis.fetch = realFetch;
  crypto.subtle.generateKey = realGenerateKey;
  http.stop(true);
});

test("a key shown but not yet saved posts nothing, and another tab's start-over voids it (#328)", async () => {
  const first = await device.prepareFirstDevice(account, "Tab A");
  // Another tab, or this one reloaded, finds no account yet and offers a new key.
  expect(await device.boot()).toEqual({ state: "first-device", account, unsaved: "Tab A" });
  await expect(first.commit()).rejects.toThrow("Another tab started the setup over");
  expect(await api.directory()).toHaveLength(0);

  const second = await device.prepareFirstDevice(account, "Tab B");
  expect(second.recoveryKey).not.toBe(first.recoveryKey);
  await second.commit();
  expect((await device.boot()).state).toBe("ready");
});
