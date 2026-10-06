// Replacing the recovery key against the real server (#348), and recovering after it, onto a
// chain whose devices recovery must not keep (#363).
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  generateRecoverySeed,
  recoveryConfirmEntry,
  recoveryEntry,
  recoveryKey,
  recoveryKeyPair,
  recoverySeedFromKey,
  type SignedEnvelope,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { api } from "./api";
import * as device from "./device";

let live: LiveServer;
let account: string;
/** This browser, joined through the owner's phone. */
let ctx: device.Ctx;
/** The account's recovery seed as the last test left it. */
let current: Uint8Array;
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
  const join = await device.startJoin(account, "This browser");
  await live.approve(join.code);
  await join.done;
  ctx = (await device.deviceContext(account)) as device.Ctx;
  current = live.owner.recoverySeed;
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

/** This browser's context as boot builds it, from the server's chain. */
async function ready(): Promise<device.Ctx> {
  const b = await device.boot();
  if (b.state !== "ready") throw new Error(`boot: ${b.state}`);
  return b.ctx;
}
const pkOf = (seed: Uint8Array) => toB64(recoveryKeyPair(seed).publicKey);

test("this browser replaces the key with the current one; nothing is posted before it is saved", async () => {
  await expect(device.prepareRecoveryKey(ctx, recoveryKey(generateRecoverySeed()))).rejects.toThrow(
    "This isn't the account's current recovery key.",
  );
  const made = await device.prepareRecoveryKey(ctx, recoveryKey(current));
  expect((await api.directory()).length).toBe(ctx.dir.length);
  const next = await made.replace();
  const seed = recoverySeedFromKey(made.recoveryKey);
  expect(next.dir.recoveryPk).toBe(pkOf(seed));
  expect(await device.recoveryState(next)).toEqual({
    set: { at: next.dir.recoverySet.at, by: "this browser", replaced: true },
  });
  current = seed;
});

test("a replacement made on the phone shows here once", async () => {
  const seed = generateRecoverySeed();
  const now = new Date().toISOString();
  const phone = { id: live.owner.device.id, signKey: live.owner.device.keys.sign.privateKey };
  await phoneAppends((d) => recoveryEntry(d, phone, recoveryKeyPair(seed), now));
  await phoneAppends((d) =>
    recoveryConfirmEntry(d, recoveryKeyPair(current).privateKey, pkOf(seed), now),
  );
  current = seed;
  const told = await ready();
  const { notice } = await device.recoveryState(told);
  expect(notice?.by).toBe("phone");
  await device.dismissRecoveryNotice(told, notice?.seq as number);
  expect((await device.recoveryState(told)).notice).toBeUndefined();
});

test("once the key is replaced, the old one recovers nothing; the new one does, and the phone goes", async () => {
  // The tests above replaced the key twice: the first one recovers nothing.
  await api.ownerSignIn("owner-secret");
  await expect(
    device.recover(account, "Thief", recoveryKey(live.owner.recoverySeed)),
  ).rejects.toThrow("This is a recovery key, but not this account's current one.");
  await device.recover(account, "Recovered", recoveryKey(current));
  const dir = verifyDirectory(await api.directory(), { account });
  // Recovery keeps no earlier device: the phone may be in someone else's hands (#363).
  expect(dir.members.get(live.owner.device.id)?.active).toBe(false);
  const active = [...dir.members.values()].filter((m) => m.active && m.member.role === "device");
  expect(active.map((m) => m.member.name)).toEqual(["Recovered"]);
});
