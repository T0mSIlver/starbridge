import { expect, test } from "bun:test";
import {
  type Answer,
  addEntry,
  claimHash,
  type Decision,
  generateMemberKeys,
  generateRecoverySeed,
  hashInput,
  newPairingCode,
  type Permission,
  pairingRequest,
  publicKeys,
  type QuotaSnapshot,
  recoverEntry,
  recoveryEntry,
  recoveryKeyPair,
  type SealedItem,
  type Settled,
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

test("machines' items spend a byte budget a minute, replaced and stored ones only", async () => {
  const probe = await setup();
  const size = quota(probe.devbox, probe.phone).boxes.reduce((n, b) => n + b.box.length, 0);
  const { s, phone, devbox } = await setup({ postedBytes: [Math.floor(size * 1.5), 60_000] });
  const first = quota(devbox, phone);
  expect((await post(s, devbox, first)).status).toBe(201);
  // Refused posts spend nothing.
  for (let i = 0; i < 3; i++) expect((await post(s, devbox, first)).status).toBe(409);
  // Snapshots replace each other, so the stored-bytes cap never sees them; the budget does.
  expect((await post(s, devbox, quota(devbox, phone))).status).toBe(201);
  const r = await post(s, devbox, quota(devbox, phone));
  expect(r.status).toBe(429);
  expect(r.json.detail).toContain("MB");
});

test("a looping machine spends its own window first, and the owner's answers always pass", async () => {
  const { s, acct, phone, devbox } = await setup({ items: [3, 60_000], machineItems: [2, 60_000] });
  const laptop = await pair(s, acct, "laptop", "machine");
  const d = decision(devbox, phone);
  expect((await post(s, devbox, d)).status).toBe(201);
  expect((await post(s, devbox, decision(devbox, phone))).status).toBe(201);
  // The machine's own window is full; the account's still has room for the laptop.
  expect((await post(s, devbox, decision(devbox, phone))).status).toBe(429);
  expect((await post(s, laptop, decision(laptop, phone))).status).toBe(201);
  // Now the account's window is full too, but answers count in the device's own.
  expect((await post(s, laptop, decision(laptop, phone))).status).toBe(429);
  expect((await post(s, phone, answer(d, phone, devbox))).status).toBe(201);
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

function permission(from: Actor, to: Actor): SealedItem {
  const input = '{"command":"ls"}';
  const body: Permission = {
    v: 1,
    id: `p${++n}`,
    to: [to.id],
    createdAt: at,
    agent: "claude-code",
    tool: "Bash",
    summary: "ls",
    input,
    inputHash: hashInput(input),
    suggestions: [],
    expiresAt: "2026-10-04T12:09:30Z",
    source: { machine: from.id, project: "starbridge", session: "s1" },
  };
  return seal("permission", body, { id: from.id, signKey: from.keys.sign.privateKey }, [to.member]);
}

test("permission prompts are capped per account like decisions", async () => {
  const { s, phone, devbox } = await setup({ permissions: 2 });
  expect((await post(s, devbox, permission(devbox, phone))).status).toBe(201);
  expect((await post(s, devbox, permission(devbox, phone))).status).toBe(201);
  const r = await post(s, devbox, permission(devbox, phone));
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("too-many-items");
});

test("each stored item is charged its rows as well as its boxes", async () => {
  const { s, phone, devbox } = await setup();
  const small = permission(devbox, phone);
  const boxes = small.boxes.reduce((n, b) => n + b.box.length, 0);
  const rows = 2 * DEFAULT_LIMITS.rowBytes;
  // Room for three prompts' boxes, but for only two prompts' rows.
  s.deps.config.limits = {
    ...DEFAULT_LIMITS,
    storedBytes: 3 * boxes + 2 * rows + DEFAULT_LIMITS.answerReserve,
  };
  expect((await post(s, devbox, small)).status).toBe(201);
  expect((await post(s, devbox, permission(devbox, phone))).status).toBe(201);
  const r = await post(s, devbox, permission(devbox, phone));
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("too-many-items");
});

test("stored bytes are capped per account, keeping room for answers, and per item", async () => {
  const { s, phone, devbox } = await setup();
  const boxes = (item: SealedItem) => item.boxes.reduce((n, b) => n + b.box.length, 0);
  const bytes = (item: SealedItem) =>
    boxes(item) + DEFAULT_LIMITS.rowBytes * (1 + item.boxes.length);
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

  s.deps.config.limits = { ...DEFAULT_LIMITS, quotaBytes: boxes(q) - 1, answerBytes: boxes(a) - 1 };
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

test("a full directory refuses device-signed adds but takes revocations and recoveries", async () => {
  const { s, acct } = await setup({ directoryEntries: 2, recoveryAdds: 1, recoveryProposals: 1 });
  const device = (id: string) => {
    const keys = generateMemberKeys();
    return { keys, member: { id, role: "device" as const, name: id, ...publicKeys(keys) } };
  };
  const phoneSigner = { id: acct.device.id, signKey: acct.device.keys.sign.privateKey };

  const full = await append(
    s,
    acct.device.token,
    addEntry(await directory(s, acct.device.token), phoneSigner, device("tablet").member, at),
  );
  expect(full.status).toBe(409);
  expect(full.json.error).toBe("directory-full");
  expect((await revoke(s, acct, "devbox")).status).toBe(201);

  const fresh = await signIn(s);
  const recover = async (id: string) => {
    const { keys, member } = device(id);
    const entry = recoverEntry(await directory(s, fresh), acct.recovery.privateKey, member, at);
    return { keys, r: await append(s, fresh, entry) };
  };
  const recovered = await recover("new-phone");
  expect(recovered.r.status).toBe(201);
  const more = (await recover("newer-phone")).r;
  expect(more.status).toBe(409);
  expect(more.json.error).toBe("directory-full");

  // A full directory still takes a few proposals, so a thief who filled it cannot stop the
  // owner replacing the key (Fable review of #368).
  const newPhone = { id: "new-phone", signKey: recovered.keys.sign.privateKey };
  const propose = async () =>
    append(
      s,
      fresh,
      recoveryEntry(
        await directory(s, fresh),
        newPhone,
        recoveryKeyPair(generateRecoverySeed()),
        at,
      ),
    );
  expect((await propose()).status).toBe(201);
  const refused = await propose();
  expect(refused.status).toBe(409);
  expect(refused.json.error).toBe("directory-full");
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
async function request(s: Server, name = "new", ip?: string) {
  const keys = generateMemberKeys();
  const code = newPairingCode();
  const claim = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const req = pairingRequest(
    { v: 1, rendezvous: code.rendezvous, role: "machine", id: name, name, ...publicKeys(keys), at },
    code,
  );
  const r = await s.call("POST", "/v1/pairings", {
    body: { request: req, claimHash: claimHash(claim) },
    headers: ip ? { "x-forwarded-for": ip } : undefined,
  });
  return { r, rendezvous: code.rendezvous, claim, req };
}

test("waiting pairings are capped per client, an IPv6 client counting as its /48", async () => {
  // The hosted caps scaled down: five /64s of one /48 cannot fill the server for another client.
  const s = await makeServer({
    trustProxy: true,
    limits: { ...DEFAULT_LIMITS, pendingPairings: 50, pairingsPerClient: 10 },
  });
  let ok = 0;
  for (let p = 0; p < 5; p++)
    for (let i = 1; i <= 10; i++)
      if (
        (await request(s, "m", `2001:db8:0:${p.toString(16)}::${i.toString(16)}`)).r.status === 201
      )
        ok++;
  expect(ok).toBe(10);
  const full = await request(s, "m", "2001:db8:0:ffff::1");
  expect(full.r.status).toBe(429);
  expect(full.r.json.error).toBe("too-many-pairings");
  expect((await request(s, "m", "2001:db8:1::1")).r.status).toBe(201);
  expect((await request(s, "m", "203.0.113.7")).r.status).toBe(201);
});

test("a pairing request's address stays in memory, never in the database (#575)", async () => {
  const s = await makeServer({ trustProxy: true });
  expect((await request(s, "m", "203.0.113.7")).r.status).toBe(201);
  const rows = s.deps.db.query("SELECT * FROM pairings").all();
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("203.0.113");
});

test("approved pairings leave the client's cap, so one address can pair many members", async () => {
  const s = await makeServer({ limits: { ...DEFAULT_LIMITS, pairingsPerClient: 1 } });
  const acct = await setupAccount(s);
  await pair(s, acct, "a", "machine");
  await pair(s, acct, "b", "machine");
  expect((await request(s)).r.status).toBe(201);
  expect((await request(s)).r.json.error).toBe("too-many-pairings");
});

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
  const [n] = DEFAULT_LIMITS.githubCallbacks;
  for (let i = 0; i <= n; i++)
    statuses.push((await s.call("GET", "/v1/auth/github/callback?code=x&state=y")).status);
  expect(statuses.slice(0, n).every((st) => st === 302)).toBe(true);
  expect(statuses[n]).toBe(429);
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

test("posting and answering an item never scans the account's items or boxes", async () => {
  const { s, phone, devbox } = await setup();
  const db = s.deps.db;
  const seen = new Set<string>();
  const query = db.query.bind(db);
  db.query = ((sql: string) => {
    seen.add(sql);
    return query(sql);
  }) as typeof db.query;
  const p = permission(devbox, phone);
  await post(s, devbox, p);
  const notice: Settled = {
    v: 1,
    id: `st${++n}`,
    itemId: p.id,
    to: [phone.id],
    outcome: "keyboard",
    at,
  };
  const key = { id: devbox.id, signKey: devbox.keys.sign.privateKey };
  expect((await post(s, devbox, seal("settled", notice, key, [phone.member]))).status).toBe(201);
  await post(s, devbox, quota(devbox, phone));
  await post(s, devbox, quota(devbox, phone));
  const d = decision(devbox, phone);
  await post(s, devbox, d);
  await post(s, phone, answer(d, phone, devbox));
  db.query = query;
  const scans = [...seen].flatMap((sql) => {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array(db.prepare(sql).paramsCount).fill(null)) as { detail: string }[];
    return (
      plan
        .map((r) => r.detail)
        // A search on the account id alone reads every one of the account's rows.
        .filter((d) => /^(SCAN|SEARCH) (items|boxes)\b/.test(d) && !/AND/.test(d))
        .map((d) => `${d}: ${sql.replace(/\s+/g, " ")}`)
    );
  });
  expect(scans).toEqual([]);
});
