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
  revokeEntry,
  seal,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { api } from "./api";
import * as device from "./device";
import { closedByPhrase, outcomeText } from "./outcome";
import * as store from "./store";
import type { InboxItem, JoinView } from "./types";

let live: LiveServer;
let ctx: device.Ctx;
const realFetch = globalThis.fetch;
const realGenerateKey = crypto.subtle.generateKey;
/** Answers in the server's place: a compromised server can send anything unsigned. */
let forge: ((path: string) => Response | undefined) | undefined;
/**
 * The notifications the service worker shows, how many of them the page closed, and whether the
 * keys were still stored when it last listed them.
 */
const shown = { open: 0, closed: 0, keys: false };

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
    getNotifications: async () => {
      shown.keys = !!(await store.get("device", ctx.account));
      return Array.from({ length: shown.open }, () => ({
        close: () => {
          shown.closed++;
        },
      }));
    },
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
    // Answered on the phone: the asking machine's later notice says with what, and only its own
    // counts (#330).
    const told = (by: (typeof machines)[0], choice: string) => ({
      item: seal(
        "settled",
        {
          v: 1,
          id: `s_${choice}`,
          itemId: "d_asked",
          to,
          at,
          outcome: "device",
          device: "phone",
          choice,
        },
        { id: by.member.id, signKey: by.keys.sign.privateKey },
        recipient,
      ),
      cursor: "1",
      receivedAt: "2026-10-06T12:00:01Z",
    });
    items[0] = told(closes, "Yes");
    expect(
      (await device.loadInbox(fresh)).items.find((i) => i.decision.id === "d_asked")?.answeredBy,
    ).toBeUndefined();
    items[0] = told(asks, "No");
    const won = (await device.loadInbox(fresh)).items.find((i) => i.decision.id === "d_asked");
    const phone = fresh.dir.members.get("phone")?.member.name;
    expect(won?.answeredBy).toEqual({ device: phone as string, reply: { choice: "No" } });
    expect(won?.settled).toBeUndefined();
    expect(outcomeText(won as InboxItem)).toBe("No");
    expect(closedByPhrase(won as InboxItem)).toBe(`on ${phone}`);
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

test("a machine's head exposes a revocation the server withholds, and holds every machine's items (#362)", async () => {
  const at = "2026-10-06T12:00:00Z";
  const phone = { id: "phone", signKey: live.owner.device.keys.sign.privateKey };
  const postEntry = async (entry: unknown) => {
    const r = await realFetch(`${live.url}/v1/directory`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.owner.device.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ entry }),
    });
    expect(r.status).toBe(201);
  };
  const machines = ["m_revoked", "m_honest"].map((id) => {
    const keys = generateMemberKeys();
    return { keys, member: { id, role: "machine" as const, name: id, ...publicKeys(keys) } };
  });
  for (const m of machines) await postEntry(addEntry(await live.directory(), phone, m.member, at));
  const before = (await device.deviceContext(ctx.account)) as device.Ctx;
  // The owner revokes one machine from the phone; the server keeps that entry from this browser.
  await postEntry(revokeEntry(await live.directory(), phone, "m_revoked", at));
  const full = await live.directory();
  const [revoked, honest] = machines as [(typeof machines)[0], (typeof machines)[0]];
  const { id, name, boxPk, signPk } = before.device;
  const to = [{ id, role: "device" as const, name, boxPk, signPk }];
  const decision = (m: typeof revoked, dir?: { length: number; head: string }) =>
    seal(
      "decision",
      {
        v: 1,
        id: `d_${m.member.id}`,
        to: [id],
        createdAt: at,
        question: "Deploy?",
        context: "",
        options: ["Yes", "No"],
        recommended: "Yes",
        source: { machine: m.member.name, project: "p", session: "s" },
        ...(dir ? { dir } : {}),
      },
      { id: m.member.id, signKey: m.keys.sign.privateKey },
      to,
    );
  const items = [
    { item: decision(revoked), cursor: "1", receivedAt: at },
    {
      item: decision(honest, { length: full.length, head: full.head }),
      cursor: "2",
      receivedAt: at,
    },
  ];
  const served = globalThis.fetch;
  let withholding = true;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    if (input.startsWith("/v1/items?kind=decision")) return Response.json({ items, cursor: "2" });
    const res = await served(input, init);
    if (input !== "/v1/directory" || !withholding) return res;
    const { entries } = (await res.json()) as { entries: unknown[] };
    return Response.json({ entries: entries.slice(0, -1) });
  }) as typeof fetch;
  try {
    const held = (await device.deviceContext(ctx.account)) as device.Ctx;
    expect(held.dir.members.get("m_revoked")?.active).toBe(true);
    await expect(device.loadInbox(held)).rejects.toThrow("holding back changes to your devices");
    // The head is kept: another load, of nothing new, holds too.
    await expect(device.loadRuns(held)).rejects.toThrow("holding back");
    // Served in full, the revoked machine's question no longer opens, and the hold ends.
    withholding = false;
    const fresh = (await device.deviceContext(ctx.account)) as device.Ctx;
    const inbox = await device.loadInbox(fresh);
    expect(inbox.items.map((i) => i.decision.id)).toEqual(["d_m_honest"]);
  } finally {
    globalThis.fetch = served;
  }
});

test("a head from an entry made elsewhere since the last read refreshes rather than holds (#362)", async () => {
  const at = "2026-10-06T12:00:00Z";
  const phone = { id: "phone", signKey: live.owner.device.keys.sign.privateKey };
  const post = async (entry: unknown) =>
    realFetch(`${live.url}/v1/directory`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.owner.device.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ entry }),
    });
  const keys = generateMemberKeys();
  const machine = { id: "m_fresh", role: "machine" as const, name: "fresh", ...publicKeys(keys) };
  await post(addEntry(await live.directory(), phone, machine, at));
  const stale = (await device.deviceContext(ctx.account)) as device.Ctx;
  // The owner adds a device from the phone; the machine reads it and signs the new head.
  const tablet = {
    id: "tablet",
    role: "device" as const,
    name: "Tablet",
    ...publicKeys(generateMemberKeys()),
  };
  await post(addEntry(await live.directory(), phone, tablet, at));
  const full = await live.directory();
  const { id, name, boxPk, signPk } = stale.device;
  const recipient = [{ id, role: "device" as const, name, boxPk, signPk }];
  const item = seal(
    "decision",
    {
      v: 1,
      id: "d_fresh",
      to: [id],
      createdAt: at,
      question: "Deploy?",
      context: "",
      options: ["Yes", "No"],
      recommended: "Yes",
      source: { machine: "fresh", project: "p", session: "s" },
      dir: { length: full.length, head: full.head },
    },
    { id: machine.id, signKey: keys.sign.privateKey },
    recipient,
  );
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) =>
    input.startsWith("/v1/items?kind=decision")
      ? Response.json({ items: [{ item, cursor: "1", receivedAt: at }], cursor: "1" })
      : served(input, init)) as typeof fetch;
  try {
    const inbox = await device.loadInbox(stale);
    expect(inbox.items.map((i) => i.decision.id)).toContain("d_fresh");
  } finally {
    globalThis.fetch = served;
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

// These revoke this browser and sign it out: they run last.
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
  await store.put("promptAnswers", {}, ctx.account);
  // Confirmed by the chain: its keys and what it answered go, and it says who removed it (#343).
  expect(await device.boot()).toMatchObject({ state: "revoked", by: mine.device.name });
  expect(shown.closed).toBe(2);
  expect(await store.get("device", ctx.account)).toBeUndefined();
  expect(await store.get("promptAnswers", ctx.account)).toBeUndefined();
  expect(await store.get("pin", ctx.account)).toBeDefined();
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
  // Closed after the keys went, so a push the service worker was opening finds none.
  expect(shown.keys).toBe(false);
});
