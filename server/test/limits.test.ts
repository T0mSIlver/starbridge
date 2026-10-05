import { expect, test } from "bun:test";
import {
  type Answer,
  addEntry,
  claimHash,
  type Decision,
  generateMemberKeys,
  newPairingCode,
  pairingRequest,
  publicKeys,
  type QuotaSnapshot,
  RECOVERY,
  type SealedItem,
  seal,
  toB64,
} from "@starbridge/protocol";
import { DEFAULT_LIMITS, type Limits } from "../src/limits";
import { RateLimiter } from "../src/ratelimit";
import { sweepStorage } from "../src/retention";
import {
  type Actor,
  append,
  at,
  directory,
  makeServer,
  pair,
  revoke,
  type Server,
  setupAccount,
  signIn,
} from "../test-support/app";

const DAY = 86_400_000;

async function setup(limits: Partial<Limits> = {}) {
  const s = await makeServer({ limits: { ...DEFAULT_LIMITS, ...limits } });
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  return { s, acct, phone: acct.device, devbox };
}

let n = 0;
function decision(from: Actor, to: Actor): SealedItem {
  const body: Decision = {
    v: 1,
    id: `d${++n}`,
    to: [to.id],
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    default: { action: "ship" },
    source: { machine: from.id, project: "starbridge", session: "s1" },
  };
  return seal("decision", body, { id: from.id, signKey: from.keys.sign.privateKey }, [to.member]);
}

function answer(d: SealedItem, by: Actor, machine: Actor): SealedItem {
  const body: Answer = {
    v: 1,
    id: `a${++n}`,
    decisionId: d.id,
    to: machine.id,
    answeredAt: at,
    choice: "yes",
  };
  return seal("answer", body, { id: by.id, signKey: by.keys.sign.privateKey }, [machine.member]);
}

function quota(from: Actor, to: Actor): SealedItem {
  const body: QuotaSnapshot = {
    v: 1,
    id: `q${++n}`,
    to: [to.id],
    takenAt: at,
    providers: [],
    alerts: [],
  };
  return seal("quota", body, { id: from.id, signKey: from.keys.sign.privateKey }, [to.member]);
}

const post = (s: Server, who: Actor, item: SealedItem) =>
  s.call("POST", "/v1/items", { token: who.token, body: item });

const exists = async (s: Server, who: Actor, id: string) =>
  (await s.call("GET", `/v1/items/${id}`, { token: who.token })).status === 200;

test("item posts past the account's rate get 429 with Retry-After", async () => {
  const { s, phone, devbox } = await setup({ items: [2, 60_000] });
  expect((await post(s, devbox, decision(devbox, phone))).status).toBe(201);
  expect((await post(s, devbox, quota(devbox, phone))).status).toBe(201);
  const r = await post(s, devbox, decision(devbox, phone));
  expect(r.status).toBe(429);
  expect(r.json.error).toBe("rate-limited");
  expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
});

test("a full account refuses new decisions but still takes answers and replaced quotas", async () => {
  const { s, phone, devbox } = await setup({ decisions: 2 });
  const first = decision(devbox, phone);
  await post(s, devbox, first);
  await post(s, devbox, decision(devbox, phone));
  const r = await post(s, devbox, decision(devbox, phone));
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("too-many-items");
  expect((await post(s, phone, answer(first, phone, devbox))).status).toBe(201);
  expect((await post(s, devbox, quota(devbox, phone))).status).toBe(201);
  expect((await post(s, devbox, quota(devbox, phone))).status).toBe(201);
});

test("stored bytes are capped per account, keeping room for answers, and per item", async () => {
  const { s, phone, devbox } = await setup();
  const bytes = (item: SealedItem) => item.boxes.reduce((n, b) => n + b.box.length, 0);
  const d = decision(devbox, phone);
  const later = decision(devbox, phone);
  expect((await post(s, devbox, d)).status).toBe(201);
  expect((await post(s, devbox, later)).status).toBe(201);
  const q = quota(devbox, phone);
  const a = answer(d, phone, devbox);
  const held = 2 * bytes(d) + bytes(q);
  s.deps.config.limits = {
    ...DEFAULT_LIMITS,
    storedBytes: held + bytes(a) + 50,
    answerReserve: bytes(a) + 40,
  };
  expect((await post(s, devbox, q)).status).toBe(201);
  // A new snapshot replaces the old one, so it fits where a decision beside it does not.
  expect((await post(s, devbox, quota(devbox, phone))).status).toBe(201);
  const r = await post(s, devbox, decision(devbox, phone));
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("too-many-items");
  expect((await post(s, phone, a)).status).toBe(201);

  s.deps.config.limits = { ...DEFAULT_LIMITS, itemBytes: bytes(q) - 1, answerBytes: bytes(a) - 1 };
  const big = await post(s, devbox, quota(devbox, phone));
  expect(big.status).toBe(413);
  expect(big.json.error).toBe("too-large");
  expect((await post(s, phone, answer(later, phone, devbox))).status).toBe(413);
});

test("the sweep drops answered decisions after a week and the rest after 30 days", async () => {
  const { s, acct, phone, devbox } = await setup();
  const laptop = await pair(s, acct, "laptop", "machine");
  const answered = decision(devbox, phone);
  const reply = answer(answered, phone, devbox);
  const open = decision(devbox, phone);
  const gone = quota(laptop, phone);
  const kept = quota(devbox, phone);
  for (const [who, item] of [
    [devbox, answered],
    [phone, reply],
    [devbox, open],
    [laptop, gone],
    [devbox, kept],
  ] as const)
    expect((await post(s, who, item)).status).toBe(201);
  await revoke(s, acct, "laptop");
  const expired = await signIn(s);
  s.deps.db
    .query(
      "UPDATE sessions SET expires_at = ? WHERE token_hash != (SELECT token_hash FROM sessions WHERE member_id = 'phone')",
    )
    .run(new Date(Date.now() - 1000).toISOString());
  const sessions = () =>
    (s.deps.db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  expect(sessions()).toBe(2);

  sweepStorage(s.deps.db, DEFAULT_LIMITS);
  expect(await exists(s, phone, gone.id)).toBe(false); // its machine was revoked
  expect(await exists(s, phone, answered.id)).toBe(true);
  expect(sessions()).toBe(1);
  expect((await s.call("GET", "/v1/me", { token: expired })).status).toBe(401);

  sweepStorage(s.deps.db, DEFAULT_LIMITS, Date.now() + 8 * DAY);
  expect(await exists(s, phone, answered.id)).toBe(false);
  expect(await exists(s, devbox, reply.id)).toBe(false);
  expect(await exists(s, phone, open.id)).toBe(true);
  expect(await exists(s, phone, kept.id)).toBe(true);

  sweepStorage(s.deps.db, DEFAULT_LIMITS, Date.now() + 31 * DAY);
  expect(await exists(s, phone, open.id)).toBe(false);
  expect(await exists(s, phone, kept.id)).toBe(false);
});

test("a full directory refuses device-signed adds but takes revocations and recovery adds", async () => {
  const { s, acct } = await setup({ directoryEntries: 2, recoveryAdds: 1 });
  const add = async (signer: { id: string; signKey: Uint8Array }, id: string) => {
    const keys = generateMemberKeys();
    const member = { id, role: "device" as const, name: id, ...publicKeys(keys) };
    return append(
      s,
      acct.device.token,
      addEntry(await directory(s, acct.device.token), signer, member, at),
    );
  };
  const phoneSigner = { id: acct.device.id, signKey: acct.device.keys.sign.privateKey };
  const recovery = { id: RECOVERY, signKey: acct.recovery.privateKey };

  const full = await add(phoneSigner, "tablet");
  expect(full.status).toBe(409);
  expect(full.json.error).toBe("directory-full");
  expect((await revoke(s, acct, "devbox")).status).toBe(201);
  expect((await add(recovery, "new-phone")).status).toBe(201);
  const more = await add(recovery, "newer-phone");
  expect(more.status).toBe(409);
  expect(more.json.error).toBe("directory-full");
  expect((await revoke(s, acct, "new-phone")).status).toBe(201);
});

test("the directory caps its append rate", async () => {
  const { s, acct } = await setup({ directoryAppends: [2, 3_600_000] });
  const limited = await revoke(s, acct, "devbox");
  expect(limited.status).toBe(429);
  expect(limited.json.error).toBe("rate-limited");
});

test("a directory entry over 8 KB is refused", async () => {
  const { s, acct } = await setup();
  const dir = await directory(s, acct.device.token);
  const keys = generateMemberKeys();
  const member = { id: "big", role: "device" as const, name: "big", ...publicKeys(keys) };
  const signer = { id: acct.device.id, signKey: acct.device.keys.sign.privateKey };
  const entry = addEntry(dir, signer, member, at);
  const r = await append(s, acct.device.token, { ...entry, sig: entry.sig.repeat(100) });
  expect(r.status).toBe(413);
});

test("signing in past the session cap ends the oldest unpaired session, never the new one", async () => {
  const s = await makeServer({ limits: { ...DEFAULT_LIMITS, sessions: 3 } });
  const acct = await setupAccount(s);
  const sessions = [];
  for (let i = 0; i < 4; i++) sessions.push(await signIn(s));
  const alive = async (token: string) => (await s.call("GET", "/v1/me", { token })).status === 200;
  expect(await alive(acct.device.token)).toBe(true);
  expect(await alive(sessions[0] as string)).toBe(false);
  expect(await alive(sessions[1] as string)).toBe(false);
  expect(await alive(sessions[2] as string)).toBe(true);
  expect(await alive(sessions[3] as string)).toBe(true);
});

/** Posts a pairing request and returns its rendezvous id and claim secret. */
async function request(s: Server, name = "new") {
  const keys = generateMemberKeys();
  const code = newPairingCode();
  const claim = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const req = pairingRequest(
    { v: 1, rendezvous: code.rendezvous, role: "machine", id: name, name, ...publicKeys(keys), at },
    code,
  );
  const r = await s.call("POST", "/v1/pairings", {
    body: { request: req, claimHash: claimHash(claim) },
  });
  return { r, rendezvous: code.rendezvous, claim, req };
}

test("pairings bound their message size, their number and their long-polls", async () => {
  const s = await makeServer({
    limits: { ...DEFAULT_LIMITS, pendingPairings: 1, pairingWaits: 1 },
  });
  const first = await request(s);
  expect(first.r.status).toBe(201);
  const busy = await request(s);
  expect(busy.r.status).toBe(429);
  expect(busy.r.json.error).toBe("busy");

  const path = `/v1/pairings/${first.rendezvous}/result?wait=1`;
  const headers = { "x-claim": first.claim };
  const waiting = s.call("GET", path, { headers });
  const second = await s.call("GET", path, { headers });
  expect(second.status).toBe(429);
  expect(second.json.error).toBe("too-many-waits");
  expect((await waiting).status).toBe(204);

  const big = { ...first.req, body: first.req.body.padEnd(5_000, " ") };
  const r = await s.call("POST", "/v1/pairings", {
    body: { request: big, claimHash: claimHash(first.claim) },
  });
  expect(r.status).toBe(400);
});

test("a machine holds a bounded number of open answer waits", async () => {
  const { s, devbox } = await setup({ answerWaits: 1 });
  const waiting = s.call("GET", "/v1/answers?wait=1", { token: devbox.token });
  const second = await s.call("GET", "/v1/answers?wait=1", { token: devbox.token });
  expect(second.status).toBe(429);
  expect(second.json.error).toBe("too-many-waits");
  expect((await waiting).status).toBe(200);
});

test("per-address limits count an IPv6 client as its /64", async () => {
  const s = await makeServer({ trustProxy: true });
  const from = (ip: string) =>
    s.call("POST", "/v1/auth/owner", {
      body: { token: "wrong" },
      headers: { "x-forwarded-for": ip },
    });
  for (let i = 1; i <= 10; i++) expect((await from(`2001:db8::${i}`)).status).toBe(401);
  expect((await from("2001:0db8:0:0:ffff::1")).status).toBe(429);
  expect((await from("2001:db8:0:1::1")).status).toBe(401);
});

test("the GitHub callback is rate-limited per address", async () => {
  const s = await makeServer({
    github: {
      clientId: "id",
      clientSecret: "secret",
      authorizeUrl: "http://127.0.0.1:1/authorize",
      tokenUrl: "http://127.0.0.1:1/token",
      apiUrl: "http://127.0.0.1:1",
    },
  });
  const statuses = [];
  for (let i = 0; i < 21; i++)
    statuses.push((await s.call("GET", "/v1/auth/github/callback?code=x&state=y")).status);
  expect(statuses.slice(0, 20).every((st) => st === 400)).toBe(true);
  expect(statuses[20]).toBe(429);
});

test("a short window's sweep leaves a longer window's count alone", () => {
  let t = 0;
  const limiter = new RateLimiter(() => t);
  expect(limiter.allow("hourly", 1, 3_600_000)).toBe(true);
  expect(limiter.allow("hourly", 1, 3_600_000)).toBe(false);
  t = 120_000;
  for (let i = 0; i <= 10_001; i++) limiter.allow(`k${i}`, 1, 60_000);
  t = 240_000;
  limiter.allow("trigger", 1, 60_000);
  expect(limiter.allow("hourly", 1, 3_600_000)).toBe(false);
});
