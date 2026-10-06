// Recovery against the real server, after the recovery key was replaced (#348) and onto a chain
// whose devices recovery must not keep (#363).
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  generateRecoverySeed,
  recoveryConfirmEntry,
  recoveryEntry,
  recoveryKey,
  recoveryKeyPair,
  type SignedEnvelope,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { api } from "./api";
import * as device from "./device";

let live: LiveServer;
let account: string;
const realFetch = globalThis.fetch;
const realGenerateKey = crypto.subtle.generateKey;

beforeAll(async () => {
  live = await LiveServer.start();
  let cookie = "";
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const res = await realFetch(`${live.url}${input}`, {
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
  live.stop();
});

/** The owner's phone appends one entry, made against the chain as the server holds it. */
async function phoneAppends(make: (d: ReturnType<typeof verifyDirectory>) => SignedEnvelope) {
  const headers = {
    authorization: `Bearer ${live.owner.device.token}`,
    "content-type": "application/json",
  };
  const read = await realFetch(`${live.url}/v1/directory`, { headers });
  const { entries } = (await read.json()) as { entries: SignedEnvelope[] };
  const r = await realFetch(`${live.url}/v1/directory`, {
    method: "POST",
    headers,
    body: JSON.stringify({ entry: make(verifyDirectory(entries)) }),
  });
  expect(r.status).toBe(201);
}

test("once the key is replaced, the old one recovers nothing; the new one does, and the phone goes", async () => {
  const seed = generateRecoverySeed();
  const now = new Date().toISOString();
  const phone = { id: live.owner.device.id, signKey: live.owner.device.keys.sign.privateKey };
  await phoneAppends((d) => recoveryEntry(d, phone, recoveryKeyPair(seed), now));
  await phoneAppends((d) =>
    recoveryConfirmEntry(
      d,
      live.owner.recovery.privateKey,
      toB64(recoveryKeyPair(seed).publicKey),
      now,
    ),
  );

  await expect(
    device.recover(account, "Thief", recoveryKey(live.owner.recoverySeed)),
  ).rejects.toThrow("This is a recovery key, but not this account's current one.");
  await device.recover(account, "Recovered", recoveryKey(seed));
  const dir = verifyDirectory(await api.directory(), { account });
  // Recovery keeps no earlier device: the phone may be in someone else's hands (#363).
  expect(dir.members.get(live.owner.device.id)?.active).toBe(false);
  const active = [...dir.members.values()].filter((m) => m.active && m.member.role === "device");
  expect(active.map((m) => m.member.name)).toEqual(["Recovered"]);
});
