// The browser's join and approval code against the real server, which fails chosen requests with
// 503 to stand in for a dropped connection.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  addEntry,
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
  seal,
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

beforeAll(async () => {
  live = await LiveServer.start();
  // The page's same-origin calls, with the session cookie a browser would keep.
  let cookie = "";
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const res = await realFetch(`${live.url}${input}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), cookie },
    });
    cookie = res.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return res;
  }) as typeof fetch;
  device.retryDelay.ms = 10;
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

test("a machine's settled notice closes only that machine's decisions (#362)", async () => {
  // Two machines; the second, say revoked but its revocation withheld, closes the first's decision.
  const at = "2026-10-06T12:00:00Z";
  const machines = ["m_asks", "m_closes"].map((id) => {
    const keys = generateMemberKeys();
    return { keys, member: { id, role: "machine" as const, name: id, ...publicKeys(keys) } };
  });
  for (const m of machines) {
    const entry = addEntry(
      await live.directory(),
      { id: "phone", signKey: live.owner.device.keys.sign.privateKey },
      m.member,
      at,
    );
    const r = await realFetch(`${live.url}/v1/directory`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.owner.device.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ entry }),
    });
    expect(r.status).toBe(201);
  }
  const fresh = (await device.deviceContext(ctx.account)) as device.Ctx;
  const [asks, closes] = machines as [(typeof machines)[0], (typeof machines)[0]];
  const to = [fresh.device.id];
  const { id, name, boxPk, signPk } = fresh.device;
  const recipient = [{ id, role: "device" as const, name, boxPk, signPk }];
  const decision = seal(
    "decision",
    {
      v: 1,
      id: "d_asked",
      to,
      createdAt: at,
      question: "Deploy?",
      context: "",
      options: ["Yes", "No"],
      recommended: "Yes",
      source: { machine: "asks", project: "p", session: "s" },
    },
    { id: asks.member.id, signKey: asks.keys.sign.privateKey },
    recipient,
  );
  const settled = seal(
    "settled",
    { v: 1, id: "s_forged", itemId: "d_asked", to, at, outcome: "withdrawn" },
    { id: closes.member.id, signKey: closes.keys.sign.privateKey },
    recipient,
  );
  const items = [
    { item: settled, cursor: "1", receivedAt: at },
    { item: decision, cursor: "2", receivedAt: at, answeredAt: at },
  ];
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) =>
    input.startsWith("/v1/items?kind=decision")
      ? Response.json({ items, cursor: "2" })
      : served(input, init)) as typeof fetch;
  try {
    const inbox = await device.loadInbox(fresh);
    const asked = inbox.items.find((i) => i.decision.id === "d_asked");
    expect(asked?.machine.id).toBe(asks.member.id);
    expect(asked?.settled).toBeUndefined();
    // The asking machine's own notice still closes it.
    items[0] = {
      item: seal(
        "settled",
        { v: 1, id: "s_own", itemId: "d_asked", to, at, outcome: "withdrawn" },
        { id: asks.member.id, signKey: asks.keys.sign.privateKey },
        recipient,
      ),
      cursor: "1",
      receivedAt: at,
    };
    const own = await device.loadInbox(fresh);
    expect(own.items.find((i) => i.decision.id === "d_asked")?.settled).toBe("withdrawn");
  } finally {
    globalThis.fetch = served;
  }
});
