// The browser's join and approval code against the real server, which fails chosen requests with
// 503 to stand in for a dropped connection.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  checkJoined,
  generateMemberKeys,
  joinCommitment,
  joinerKeys,
  joinRequest,
  newJoinId,
  newJoinKeyPair,
  openJoinApproval,
  publicKeys,
  recoveryKey,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { api } from "./api";
import * as device from "./device";
import * as store from "./store";
import type { JoinView } from "./types";

let live: LiveServer;
let ctx: device.Ctx;
const realFetch = globalThis.fetch;
const realGenerateKey = crypto.subtle.generateKey;
/** Answers in the server's place: a compromised server can send anything unsigned. */
let forge: ((path: string) => Response | undefined) | undefined;
/** The notifications the service worker shows, and which of them the page closed. */
const shown = { open: 0, closed: 0 };

beforeAll(async () => {
  live = await LiveServer.start();
  // The page's same-origin calls, with the session cookie a browser would keep.
  let cookie = "";
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const forged = forge?.(input);
    if (forged) return forged;
    const res = await realFetch(`${live.url}${input}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), cookie },
    });
    cookie = res.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return res;
  }) as typeof fetch;
  device.retryDelay.ms = 10;
  const registration = {
    pushManager: { getSubscription: async () => null },
    getNotifications: async () =>
      Array.from({ length: shown.open }, () => ({
        close: () => {
          shown.closed++;
        },
      })),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => registration },
  });
  // Bun cannot store a CryptoKey in IndexedDB, so the keys take the raw libsodium fallback.
  crypto.subtle.generateKey = (() =>
    Promise.reject(new Error("no WebCrypto keys"))) as typeof crypto.subtle.generateKey;
  await api.ownerSignIn("owner-secret");
  const { account } = await api.me();
  const join = await device.startJoin(account, "This browser");
  await live.approve(join.code);
  await join.done;
  ctx = (await device.deviceContext(account)) as device.Ctx;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  crypto.subtle.generateKey = realGenerateKey;
  Reflect.deleteProperty(navigator, "serviceWorker");
  live.stop();
});

/** Another browser of the account, signed in, asks to join; it calls the server directly. */
async function joiner() {
  const r = await realFetch(`${live.url}/v1/auth/owner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "owner-secret" }),
  });
  const { session } = (await r.json()) as { session: string };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await realFetch(`${live.url}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
    return (await res.json()) as { join: JoinView };
  };
  const keys = generateMemberKeys();
  const eph = newJoinKeyPair();
  const id = newJoinId();
  const member = { id: `w_${id}`, name: "New browser", ...publicKeys(keys) };
  const request = joinRequest({
    v: 1,
    join: id,
    account: ctx.account,
    ...member,
    at: "2026-10-05T12:00:00Z",
  });
  const { join: view } = await call("POST", "/joins", {
    request,
    commitment: joinCommitment(eph.publicKey, request),
  });
  /** Waits for the approver's key, reveals, and returns the digits it shows. */
  const reveal = async () => {
    // Leaves the planted failures to the browser.
    while (live.failures.length) await Bun.sleep(5);
    let join = view;
    while (!join.approverKey)
      join = (await call("GET", `/joins/${id}?after=${join.version}&wait=5`)).join;
    await call("POST", `/joins/${id}/reveal`, { key: toB64(eph.publicKey) });
    return joinerKeys({ mine: eph, approverKey: join.approverKey, request });
  };
  const ask = { id, name: member.name, at: view.createdAt, view };
  return { id, member, ask, reveal, call };
}

test("comparing digits survives a failed poll, and a failed approval retries onto the same entry", async () => {
  const j = joiner();
  const { id, member, ask, reveal, call } = await j;
  // The first poll after this browser posts its key fails: giving up would strand the join,
  // since the server takes one approver key.
  live.failures.push(`/joins/${id}`);
  const [comparison, keys] = await Promise.all([
    device.compareJoin(ctx, ask, new AbortController().signal),
    reveal(),
  ]);
  expect(comparison.digits).toBe(keys.digits);

  // The entry lands but the approval's post fails; Approve again reuses the entry.
  live.errors.push(`/joins/${id}/approve`);
  await expect(comparison.approve(ctx)).rejects.toThrow("internal");
  await comparison.approve(ctx);

  const { join } = await call("GET", `/joins/${id}`);
  const body = openJoinApproval(join.approval, keys, id);
  const dir = verifyDirectory((await api.directory()) as never, {
    account: ctx.account,
    pin: { length: body.length, head: body.head },
  });
  checkJoined(dir, { ...member, role: "device" });
  expect([...dir.members.keys()].filter((m) => m === member.id)).toHaveLength(1);
});

test("signing in again survives two failed challenges and keeps the device's keys (#274)", async () => {
  const before = await store.get("device", ctx.account);
  device.bindRetry.waits = [1, 1, 1];
  // A new sign-in session: the server knows no device for it until this browser binds.
  await api.ownerSignIn("owner-secret");
  live.failures.push("/auth/challenge", "/auth/challenge");
  const b = await device.boot();
  expect(b.state).toBe("ready");
  expect(await store.get("device", ctx.account)).toEqual(before as store.DeviceRecord);
});

test("a join leaves the device's keys alone until a device approves it (#274)", async () => {
  const before = await store.get("device", ctx.account);
  const join = await device.startJoin(ctx.account, "Pairing again");
  join.cancel();
  await join.done.catch(() => {});
  expect(await store.get("device", ctx.account)).toEqual(before as store.DeviceRecord);
  expect((await store.get("pending", ctx.account))?.name).toBe("Pairing again");
});

test("a join approved but cut off before its keys were saved resumes on the next boot (#274)", async () => {
  // This browser's device, as a join would hold it before adopting: approved, not yet saved.
  const record = (await store.get("device", ctx.account)) as store.DeviceRecord;
  await store.put("pending", record, ctx.account);
  await store.del("device", ctx.account);
  const b = await device.boot();
  expect(b.state).toBe("ready");
  expect(await store.get("device", ctx.account)).toEqual(record);
  expect(await store.get("pending", ctx.account)).toBeUndefined();
});

test("a recovery whose directory append fails leaves the device's keys alone (#283)", async () => {
  const before = await store.get("device", ctx.account);
  live.errors.push("POST /directory");
  const words = recoveryKey(live.owner.recoverySeed);
  await expect(device.recover(ctx.account, "Recovered", words)).rejects.toThrow("internal");
  expect(await store.get("device", ctx.account)).toEqual(before as store.DeviceRecord);
  expect((await store.get("pending", ctx.account))?.name).toBe("Recovered");
  await store.del("pending", ctx.account);
});

test("a recovery that landed but was cut off before adopting its keys resumes over an older device (#283)", async () => {
  const before = (await store.get("device", ctx.account)) as store.DeviceRecord;
  // A fresh sign-in, bound to no device: the server binds it to the recovered one.
  await api.ownerSignIn("owner-secret");
  await device.recover(ctx.account, "Recovered", recoveryKey(live.owner.recoverySeed));
  const recovered = (await store.get("device", ctx.account)) as store.DeviceRecord;
  // As the browser held it when the page closed after the append: the older device still stored.
  await store.put("pending", recovered, ctx.account);
  await store.put("device", before, ctx.account);
  const b = await device.boot();
  expect(b.state).toBe("ready");
  expect(await store.get("device", ctx.account)).toEqual(recovered);
  expect(await store.get("pending", ctx.account)).toBeUndefined();
});

test("an unsigned 401 revoked from the server keeps the device's keys (#310)", async () => {
  const before = await store.get("device", ctx.account);
  expect((await device.boot()).state).toBe("ready");
  forge = (path) =>
    path === "/v1/me"
      ? new Response(JSON.stringify({ error: "revoked" }), { status: 401 })
      : undefined;
  shown.open = 1;
  shown.closed = 0;
  const b = await device.boot();
  forge = undefined;
  expect(b).toMatchObject({ state: "signed-out", known: true, refused: "revoked" });
  expect(await store.get("device", ctx.account)).toEqual(before as store.DeviceRecord);
  // Its notifications close all the same: that loses nothing.
  expect(shown.closed).toBe(1);
  // The chain still lists the device, and the session still works: nothing was lost.
  expect((await device.boot()).state).toBe("ready");
});

test("a revocation the chain confirms shows as revoked and closes the notifications (#310, #311)", async () => {
  const mine = (await device.deviceContext(ctx.account)) as device.Ctx;
  await device.revoke(mine, mine.device.id);
  // The server ends the session; the keys stay until the chain says why.
  expect(await device.boot()).toMatchObject({
    state: "signed-out",
    known: true,
    refused: "revoked",
  });
  await api.ownerSignIn("owner-secret");
  shown.open = 2;
  shown.closed = 0;
  expect((await device.boot()).state).toBe("revoked");
  expect(shown.closed).toBe(2);
});

test("recovering closes the notifications (#311)", async () => {
  shown.open = 1;
  shown.closed = 0;
  await device.recover(ctx.account, "Recovered again", recoveryKey(live.owner.recoverySeed));
  expect(shown.closed).toBe(1);
  expect((await device.boot()).state).toBe("ready");
});

test("signing out closes the notifications (#311)", async () => {
  const mine = (await device.deviceContext(ctx.account)) as device.Ctx;
  shown.open = 3;
  shown.closed = 0;
  await device.signOut(mine);
  expect(shown.closed).toBe(3);
});
