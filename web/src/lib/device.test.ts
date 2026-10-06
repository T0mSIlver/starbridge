// The browser's join and approval code against the real server, which fails chosen requests with
// 503 to stand in for a dropped connection.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  addEntry,
  approverKeys,
  checkJoined,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  joinApproval,
  joinCommitment,
  joinerKeys,
  joinRequest,
  newJoinId,
  newJoinKeyPair,
  openJoinApproval,
  publicKeys,
  recoveryKey,
  recoveryKeyPair,
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

test("a join cut off on a browser with no pin starts over rather than trust the served chain (#354)", async () => {
  const record = (await store.get("device", ctx.account)) as store.DeviceRecord;
  const pin = await store.get("pin", ctx.account);
  // A browser that never pinned this account, its join cut off before the approval arrived.
  await store.put("pending", record, ctx.account);
  await store.del("device", ctx.account);
  await store.del("pin", ctx.account);
  // The server serves a chain of its own: its genesis device, then an add of the pending keys.
  const x = generateMemberKeys();
  const at = "2026-10-06T12:00:00Z";
  const fake = { id: "w_server", role: "device" as const, name: "Server", ...publicKeys(x) };
  const genesis = genesisEntry({
    account: ctx.account,
    device: fake,
    signKey: x.sign.privateKey,
    recovery: recoveryKeyPair(generateRecoverySeed()),
    at,
  });
  const { keys: _, account: __, ...pending } = record;
  const add = addEntry(
    verifyDirectory([genesis]),
    { id: fake.id, signKey: x.sign.privateKey },
    { ...pending, role: "device" },
    at,
  );
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) =>
    input === "/v1/directory"
      ? Response.json({ entries: [genesis, add] })
      : served(input, init)) as typeof fetch;
  try {
    const b = await device.boot();
    expect(b.state).toBe("join");
    expect(await store.get("device", ctx.account)).toBeUndefined();
    expect(await store.get("pending", ctx.account)).toBeUndefined();
    expect(await store.get("pin", ctx.account)).toBeUndefined();
    // Nor does a device saved without a pin: the chain must start with its own genesis.
    await store.put("device", record, ctx.account);
    expect((await device.boot()).state).toBe("join");
    expect(await store.get("pin", ctx.account)).toBeUndefined();
  } finally {
    globalThis.fetch = served;
    await store.put("device", record, ctx.account);
    if (pin) await store.put("pin", pin, ctx.account);
  }
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

test("a join by digits counts the approval only once this browser's owner confirms the digits (#355)", async () => {
  const record = (await store.get("device", ctx.account)) as store.DeviceRecord;
  const pin = await store.get("pin", ctx.account);
  // A new sign-in session, bound to no device, asks to join; the phone compares and approves.
  await api.ownerSignIn("owner-secret");
  const join = await device.startDigitJoin(ctx.account, "Digits");
  const phone = async (method: string, path: string, body?: unknown) => {
    const res = await realFetch(`${live.url}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${live.owner.device.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
    return (await res.json()) as {
      join: JoinView;
      joins: JoinView[];
      length: number;
      head: string;
    };
  };
  const { joins } = await phone("GET", "/joins?after=0&wait=0");
  let view = joins.find((v) => JSON.parse(v.request).name === "Digits") as JoinView;
  const eph = newJoinKeyPair();
  ({ join: view } = await phone("POST", `/joins/${view.id}/approver`, {
    key: toB64(eph.publicKey),
    approver: "phone",
  }));
  while (!view.joinerKey)
    ({ join: view } = await phone("GET", `/joins/${view.id}?after=${view.version}&wait=5`));
  const keys = approverKeys({
    mine: eph,
    joinerKey: view.joinerKey,
    request: view.request,
    commitment: view.commitment,
  });
  expect(await join.digits).toBe(keys.digits);
  const asked = JSON.parse(view.request);
  const add = addEntry(
    await live.directory(),
    { id: "phone", signKey: live.owner.device.keys.sign.privateKey },
    { id: asked.id, role: "device", name: asked.name, boxPk: asked.boxPk, signPk: asked.signPk },
    "2026-10-06T12:00:00Z",
  );
  const head = await phone("POST", "/directory", { entry: add });
  const approval = joinApproval(
    {
      v: 1,
      join: view.id,
      account: ctx.account,
      length: head.length,
      head: head.head,
      approver: "phone",
    },
    keys,
  );
  await phone("POST", `/joins/${view.id}/approve`, { approval });
  try {
    // The approval is on the server, but this browser's owner has not compared the digits yet.
    const first = await Promise.race([join.done.then(() => "done"), Bun.sleep(500)]);
    expect(first).toBeUndefined();
    expect((await store.get("pending", ctx.account))?.name).toBe("Digits");
    join.confirm();
    await join.done;
    expect((await store.get("device", ctx.account))?.name).toBe("Digits");
  } finally {
    join.cancel();
    await store.put("device", record, ctx.account);
    if (pin) await store.put("pin", pin, ctx.account);
  }
});

// Last: a recovery revokes every other member, the owner's phone included (#363).
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
