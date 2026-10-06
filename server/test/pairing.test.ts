import { expect, test } from "bun:test";
import {
  addEntry,
  checkJoined,
  claimHash,
  generateMemberKeys,
  newPairingCode,
  openPairingApproval,
  openPairingRequest,
  pairingApproval,
  pairingRequest,
  publicKeys,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { DEFAULT_LIMITS } from "../src/limits";
import {
  type Account,
  append,
  at,
  directory,
  makeServer,
  pair,
  type Server,
  setupAccount,
  signIn,
} from "../test-support/app";

/** Posts a pairing request for a new machine and returns what the flow needs. */
async function request(
  s: Server,
  id = "devbox",
  keys = generateMemberKeys(),
  code = newPairingCode(),
  role: "device" | "machine" = "machine",
) {
  const claim = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const body = {
    v: 1 as const,
    rendezvous: code.rendezvous,
    role,
    id,
    name: id,
    ...publicKeys(keys),
    at,
  };
  const msg = pairingRequest(body, code);
  const r = await s.call("POST", "/v1/pairings", {
    body: { request: msg, claimHash: claimHash(claim) },
  });
  return { r, keys, code, claim, body, msg };
}

async function approve(s: Server, acct: Account, p: Awaited<ReturnType<typeof request>>) {
  const dir = await directory(s, acct.device.token);
  const signer = { id: acct.device.id, signKey: acct.device.keys.sign.privateKey };
  const added = await append(
    s,
    acct.device.token,
    addEntry(
      dir,
      signer,
      {
        id: p.body.id,
        role: "machine",
        name: p.body.name,
        boxPk: p.body.boxPk,
        signPk: p.body.signPk,
      },
      at,
    ),
  );
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: p.code.rendezvous,
      account: acct.id,
      length: added.json.length,
      head: added.json.head,
      approver: acct.device.id,
    },
    p.code,
  );
  return s.call("POST", `/v1/pairings/${p.code.rendezvous}/approve`, {
    token: acct.device.token,
    body: { approval },
  });
}

test("a machine pairs and gets a working token; the device and the machine check each other", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const p = await request(s);
  expect(p.r.status).toBe(201);

  // The owner types the code on the phone, which fetches the request and checks its MAC.
  const got = await s.call("GET", `/v1/pairings/${p.code.rendezvous}`, {
    token: acct.device.token,
  });
  expect(openPairingRequest(got.json.request, p.code).signPk).toBe(p.body.signPk);
  expect((await approve(s, acct, p)).status).toBe(200);

  const res = await s.call("GET", `/v1/pairings/${p.code.rendezvous}/result`, {
    headers: { "x-claim": p.claim },
  });
  expect(res.status).toBe(200);
  const approval = openPairingApproval(res.json.approval, p.code);
  const entries = (await s.call("GET", "/v1/directory", { token: res.json.token })).json.entries;
  const dir = verifyDirectory(entries, { pin: { length: approval.length, head: approval.head } });
  checkJoined(dir, { id: "devbox", role: "machine", ...publicKeys(p.keys) });
  expect((await s.call("GET", "/v1/me", { token: res.json.token })).json).toEqual({
    account: acct.id,
    member: "devbox",
    role: "machine",
  });
});

test("the result refuses a wrong claim", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const p = await request(s);
  await approve(s, acct, p);
  const r = await s.call("GET", `/v1/pairings/${p.code.rendezvous}/result`, {
    headers: { "x-claim": "wrong" },
  });
  expect(r.status).toBe(403);
  expect(r.json.token).toBeUndefined();
});

test("the result long-poll returns 204 when wait passes and completes on approval", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const p = await request(s);
  const url = `/v1/pairings/${p.code.rendezvous}/result`;
  expect(
    (await s.call("GET", `${url}?wait=0.05`, { headers: { "x-claim": p.claim } })).status,
  ).toBe(204);

  const polling = s.call("GET", `${url}?wait=30`, { headers: { "x-claim": p.claim } });
  await Bun.sleep(20);
  expect(s.deps.pairings.count(p.code.rendezvous)).toBe(1);
  await approve(s, acct, p);
  const r = await polling;
  expect(r.status).toBe(200);
  expect(r.json.token).toStartWith("sbm_");
});

test("approval needs the new member's entry in the directory first", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const p = await request(s);
  const dir = await directory(s, acct.device.token);
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: p.code.rendezvous,
      account: acct.id,
      length: dir.length,
      head: dir.head,
      approver: "phone",
    },
    p.code,
  );
  const r = await s.call("POST", `/v1/pairings/${p.code.rendezvous}/approve`, {
    token: acct.device.token,
    body: { approval },
  });
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("not-in-directory");
});

test("an entry with other keys than the request's does not count", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const p = await request(s);
  // The server swapped the machine's keys for its own: the entry carries those.
  p.body.signPk = publicKeys(generateMemberKeys()).signPk;
  expect((await approve(s, acct, p)).status).toBe(409);
});

test("a rendezvous id in use gets 409; one approval only", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const p = await request(s);
  const again = await s.call("POST", "/v1/pairings", {
    body: { request: p.msg, claimHash: claimHash("x") },
  });
  expect(again.status).toBe(409);
  expect((await approve(s, acct, p)).status).toBe(200);
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: p.code.rendezvous,
      account: acct.id,
      length: 2,
      head: "AAAA",
      approver: "phone",
    },
    p.code,
  );
  const r = await s.call("POST", `/v1/pairings/${p.code.rendezvous}/approve`, {
    token: acct.device.token,
    body: { approval },
  });
  expect(r.status).toBe(409);
});

test("reading and approving a pairing needs a paired device", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const m = await pair(s, acct, "devbox", "machine");
  const p = await request(s, "other");
  const path = `/v1/pairings/${p.code.rendezvous}`;
  expect((await s.call("GET", path)).status).toBe(401);
  expect((await s.call("GET", path, { token: m.token })).status).toBe(403);
  expect((await s.call("GET", path, { token: await signIn(s) })).status).toBe(403);
  expect(
    (
      await s.call("POST", `${path}/approve`, {
        token: m.token,
        body: { approval: { body: "{}", mac: "AA" } },
      })
    ).status,
  ).toBe(403);
});

test("an approval naming another account is refused", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const p = await request(s);
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: p.code.rendezvous,
      account: "other",
      length: 2,
      head: "AAAA",
      approver: "phone",
    },
    p.code,
  );
  const r = await s.call("POST", `/v1/pairings/${p.code.rendezvous}/approve`, {
    token: acct.device.token,
    body: { approval },
  });
  expect(r.status).toBe(400);
});

test("pairing requests are rate-limited per IP", async () => {
  const s = await makeServer();
  const statuses: number[] = [];
  const [n] = DEFAULT_LIMITS.pairingPosts;
  for (let i = 0; i <= n; i++) statuses.push((await request(s, `m${i}`)).r.status);
  expect(statuses.slice(0, n).every((x) => x === 201)).toBe(true);
  expect(statuses[n]).toBe(429);
});

test("a second device pairs with its own session, which then belongs to it", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const session = await signIn(s);
  const laptop = await pair(s, acct, "laptop", "device", session);
  expect((await s.call("GET", "/v1/me", { token: laptop.token })).json.member).toBe("laptop");
});

test("a device's result needs a session of the approving account", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  await expect(pair(s, acct, "laptop", "device")).rejects.toThrow("result: 403");
});

test("an expired pairing is gone with the machine token it held", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const p = await request(s);
  await approve(s, acct, p);
  s.deps.db.query("UPDATE pairings SET created_at = created_at - 11 * 60000").run();
  const r = await s.call("GET", `/v1/pairings/${p.code.rendezvous}/result`, {
    headers: { "x-claim": p.claim },
  });
  expect(r.status).toBe(404);
  expect(s.deps.db.query("SELECT token FROM pairings").all()).toEqual([]);
});

/** An approval for the directory as it stands, without appending anything. */
async function approveAsIs(s: Server, acct: Account, p: Awaited<ReturnType<typeof request>>) {
  const dir = await directory(s, acct.device.token);
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: p.code.rendezvous,
      account: acct.id,
      length: dir.length,
      head: dir.head,
      approver: acct.device.id,
    },
    p.code,
  );
  return s.call("POST", `/v1/pairings/${p.code.rendezvous}/approve`, {
    token: acct.device.token,
    body: { approval },
  });
}

test("pairing an existing member's keys again mints no new credential", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  const again = await request(s, "devbox", devbox.keys);
  const r = await approveAsIs(s, acct, again);
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("already-paired");
  // Nor can the first device be paired onto another session.
  const phone = await request(s, "phone", acct.device.keys, newPairingCode(), "device");
  const r2 = await approveAsIs(s, acct, phone);
  expect(r2.status).toBe(409);
  expect(r2.json.error).toBe("already-paired");
});

test("a result long-poll whose pairing expired and was replaced gets nothing", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const first = await request(s);
  const url = `/v1/pairings/${first.code.rendezvous}/result?wait=30`;
  const polling = s.call("GET", url, { headers: { "x-claim": first.claim } });
  await Bun.sleep(20);
  s.deps.db.query("UPDATE pairings SET created_at = created_at - 11 * 60000").run();
  // Someone else's pairing lands on the same rendezvous id and is approved.
  const second = await request(s, "other", generateMemberKeys(), first.code);
  expect(second.r.status).toBe(201);
  expect((await approve(s, acct, second)).status).toBe(200);
  const r = await polling;
  expect(r.status).toBe(404);
  expect(r.json.token).toBeUndefined();
});

test("a device showing a QR code waits for the new member's request", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const code = newPairingCode();
  const path = `/v1/pairings/${code.rendezvous}`;
  expect((await s.call("GET", `${path}?wait=0.05`, { token: acct.device.token })).status).toBe(204);
  expect((await s.call("GET", path, { token: acct.device.token })).status).toBe(404);
  const waiting = s.call("GET", `${path}?wait=30`, { token: acct.device.token });
  const p = await request(s, "devbox", generateMemberKeys(), code);
  expect(p.r.status).toBe(201);
  const got = await waiting;
  expect(got.status).toBe(200);
  expect(openPairingRequest(got.json.request, code).id).toBe("devbox");
});
