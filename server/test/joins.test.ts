import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  addEntry,
  approverKeys,
  checkJoined,
  generateMemberKeys,
  joinApproval,
  joinCommitment,
  joinerKeys,
  joinRequest,
  type KeyPair,
  newJoinId,
  newJoinKeyPair,
  openJoinApproval,
  openJoinRequest,
  publicKeys,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import {
  type Account,
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

// A UnifiedPush endpoint without Web Push keys: the server posts the payload as is.
let pushes: string[] = [];
let endpoint: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  endpoint = Bun.serve({
    port: 0,
    async fetch(req) {
      pushes.push(await req.text());
      return new Response(null, { status: 201 });
    },
  });
});
afterAll(() => endpoint.stop(true));

interface Joiner {
  session: string;
  id: string;
  request: string;
  eph: KeyPair;
  keys: ReturnType<typeof generateMemberKeys>;
}

/** A new browser signed in to the account posts a join request. */
async function ask(s: Server, acct: Account, eph = newJoinKeyPair()) {
  const session = await signIn(s);
  const keys = generateMemberKeys();
  const id = newJoinId();
  const request = joinRequest({
    v: 1,
    join: id,
    account: acct.id,
    id: `w_${id}`,
    name: "New browser",
    ...publicKeys(keys),
    at,
  });
  const r = await s.call("POST", "/v1/joins", {
    token: session,
    body: { request, commitment: joinCommitment(eph.publicKey, request) },
  });
  return { r, j: { session, id, request, eph, keys } satisfies Joiner };
}

const phone = (acct: Account) => acct.device.token;

/** The phone takes the request and posts its key; the joiner reveals; both derive. */
async function compare(s: Server, acct: Account, j: Joiner) {
  const eph = newJoinKeyPair();
  let r = await s.call("POST", `/v1/joins/${j.id}/approver`, {
    token: phone(acct),
    body: { key: toB64(eph.publicKey), approver: acct.device.id },
  });
  expect(r.status).toBe(200);
  r = await s.call("GET", `/v1/joins/${j.id}`, { token: j.session });
  expect(r.json.join.state).toBe("comparing");
  const mine = joinerKeys({
    mine: j.eph,
    approverKey: r.json.join.approverKey,
    request: j.request,
  });
  r = await s.call("POST", `/v1/joins/${j.id}/reveal`, {
    token: j.session,
    body: { key: toB64(j.eph.publicKey) },
  });
  expect(r.status).toBe(200);
  r = await s.call("GET", `/v1/joins/${j.id}`, { token: phone(acct) });
  const theirs = approverKeys({
    mine: eph,
    joinerKey: r.json.join.joinerKey,
    request: r.json.join.request,
    commitment: r.json.join.commitment,
  });
  return { mine, theirs };
}

async function approve(s: Server, acct: Account, j: Joiner, keys: ReturnType<typeof approverKeys>) {
  const body = openJoinRequest(j.request);
  const signer = { id: acct.device.id, signKey: acct.device.keys.sign.privateKey };
  const member = {
    id: body.id,
    role: "device" as const,
    name: body.name,
    boxPk: body.boxPk,
    signPk: body.signPk,
  };
  const added = await append(
    s,
    phone(acct),
    addEntry(await directory(s, phone(acct)), signer, member, at),
  );
  expect(added.status).toBe(201);
  const approval = joinApproval(
    {
      v: 1,
      join: j.id,
      account: acct.id,
      length: added.json.length,
      head: added.json.head,
      approver: acct.device.id,
    },
    keys,
  );
  return s.call("POST", `/v1/joins/${j.id}/approve`, { token: phone(acct), body: { approval } });
}

test("a signed-in browser joins by digits, and the phone hears of it live", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  pushes = [];
  let r = await s.call("POST", "/v1/push/subscriptions", {
    token: phone(acct),
    body: { type: "unifiedpush", endpoint: `http://localhost:${endpoint.port}/up` },
  });
  expect(r.status).toBe(201);

  const listed = await s.call("GET", "/v1/joins", { token: phone(acct) });
  expect(listed.json.joins).toEqual([]);
  // The phone's long-poll is open when the request arrives.
  const waiting = s.call("GET", `/v1/joins?after=${listed.json.cursor}&wait=30`, {
    token: phone(acct),
  });
  const { r: posted, j } = await ask(s, acct);
  expect(posted.status).toBe(201);
  const woke = await waiting;
  expect(woke.json.joins.map((x: { id: string }) => x.id)).toEqual([j.id]);
  expect(woke.json.joins[0].state).toBe("open");
  await s.deps.push.idle();
  expect(pushes.map((p) => JSON.parse(p))).toEqual([{ v: 1, kind: "join", id: j.id }]);

  // The joiner's long-poll wakes when the phone posts its key.
  const joinerWait = s.call(
    "GET",
    `/v1/joins/${j.id}?after=${woke.json.joins[0].version}&wait=30`,
    {
      token: j.session,
    },
  );
  const { mine, theirs } = await compare(s, acct, j);
  const compared = await joinerWait;
  expect(compared.json.join.state).not.toBe("open");
  expect(mine.digits).toBe(theirs.digits);
  expect(mine.digits).toMatch(/^\d{6}$/);

  // The joiner's long-poll outlives the approval, which binds its session to the new device.
  const before = (await s.call("GET", `/v1/joins/${j.id}`, { token: j.session })).json.join;
  const approvalWait = s.call("GET", `/v1/joins/${j.id}?after=${before.version}&wait=30`, {
    token: j.session,
  });
  r = await approve(s, acct, j, theirs);
  expect(r.status).toBe(200);
  const approved = await approvalWait;
  expect(approved.status).toBe(200);
  expect(approved.json.join.state).toBe("approved");
  r = await s.call("GET", `/v1/joins/${j.id}`, { token: j.session });
  expect(r.json.join.state).toBe("approved");
  const ok = openJoinApproval(r.json.join.approval, mine, j.id);
  const entries = (await s.call("GET", "/v1/directory", { token: j.session })).json.entries;
  const dir = verifyDirectory(entries, {
    account: acct.id,
    pin: { length: ok.length, head: ok.head },
  });
  checkJoined(dir, { id: `w_${j.id}`, role: "device", ...publicKeys(j.keys) });
  // The joining session is the new device's now.
  expect((await s.call("GET", "/v1/me", { token: j.session })).json.member).toBe(`w_${j.id}`);
  expect((await s.call("GET", "/v1/joins", { token: phone(acct) })).json.joins).toEqual([]);
});

test("each step refuses the wrong caller or the wrong order", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const { j } = await ask(s, acct);

  // A paired session cannot ask; an unknown session cannot see; the joiner cannot list.
  expect((await s.call("POST", "/v1/joins", { token: phone(acct), body: {} })).status).toBe(409);
  const other = await setupAccount(await makeServer());
  expect((await s.call("GET", `/v1/joins/${j.id}`, { token: other.device.token })).status).toBe(
    404,
  );
  expect((await s.call("GET", "/v1/joins", { token: j.session })).status).toBe(403);
  const stranger = await signIn(s);
  expect((await s.call("GET", `/v1/joins/${j.id}`, { token: stranger })).status).toBe(404);

  // Reveal before any approver; approve before comparing.
  let r = await s.call("POST", `/v1/joins/${j.id}/reveal`, {
    token: j.session,
    body: { key: toB64(j.eph.publicKey) },
  });
  expect(r.json.error).toBe("not-ready");

  const eph = newJoinKeyPair();
  r = await s.call("POST", `/v1/joins/${j.id}/approver`, {
    token: phone(acct),
    body: { key: toB64(eph.publicKey), approver: "someone-else" },
  });
  expect(r.status).toBe(400);
  r = await s.call("POST", `/v1/joins/${j.id}/approver`, {
    token: phone(acct),
    body: { key: toB64(eph.publicKey), approver: acct.device.id },
  });
  expect(r.status).toBe(200);
  r = await s.call("POST", `/v1/joins/${j.id}/approver`, {
    token: phone(acct),
    body: { key: toB64(eph.publicKey), approver: acct.device.id },
  });
  expect(r.json.error).toBe("taken");

  // Only the joining session reveals, and only the committed key.
  r = await s.call("POST", `/v1/joins/${j.id}/reveal`, {
    token: phone(acct),
    body: { key: toB64(j.eph.publicKey) },
  });
  expect(r.status).toBe(404);
  r = await s.call("POST", `/v1/joins/${j.id}/reveal`, {
    token: j.session,
    body: { key: toB64(newJoinKeyPair().publicKey) },
  });
  expect(r.json.error).toBe("bad-commitment");
  const theirs = approverKeys({
    mine: eph,
    joinerKey: toB64(j.eph.publicKey),
    request: j.request,
    commitment: joinCommitment(j.eph.publicKey, j.request),
  });
  const approval = joinApproval(
    { v: 1, join: j.id, account: acct.id, length: 2, head: "AAAA", approver: acct.device.id },
    theirs,
  );
  r = await s.call("POST", `/v1/joins/${j.id}/approve`, { token: phone(acct), body: { approval } });
  expect(r.json.error).toBe("not-ready");
  r = await s.call("POST", `/v1/joins/${j.id}/reveal`, {
    token: j.session,
    body: { key: toB64(j.eph.publicKey) },
  });
  expect(r.status).toBe(200);
  // Approving needs the entry in the directory first.
  r = await s.call("POST", `/v1/joins/${j.id}/approve`, { token: phone(acct), body: { approval } });
  expect(r.json.error).toBe("not-in-directory");
  expect((await approve(s, acct, j, theirs)).status).toBe(200);
  r = await s.call("POST", `/v1/joins/${j.id}/approve`, { token: phone(acct), body: { approval } });
  expect(r.json.error).toBe("closed");
});

test("cancelling closes the request, and a new request replaces the session's last", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const { j } = await ask(s, acct);
  expect((await s.call("DELETE", `/v1/joins/${j.id}`, { token: phone(acct) })).status).toBe(204);
  let r = await s.call("GET", `/v1/joins/${j.id}`, { token: j.session });
  expect(r.json.join.state).toBe("cancelled");
  r = await s.call("POST", `/v1/joins/${j.id}/approver`, {
    token: phone(acct),
    body: { key: toB64(newJoinKeyPair().publicKey), approver: acct.device.id },
  });
  expect(r.json.error).toBe("closed");

  const first = await ask(s, acct);
  const id2 = newJoinId();
  const request = joinRequest({ ...openJoinRequest(first.j.request), join: id2 });
  r = await s.call("POST", "/v1/joins", {
    token: first.j.session,
    body: { request, commitment: joinCommitment(first.j.eph.publicKey, request) },
  });
  expect(r.status).toBe(201);
  const open = (await s.call("GET", "/v1/joins", { token: phone(acct) })).json.joins;
  expect(open.map((x: { id: string }) => x.id)).toEqual([id2]);
  // A request naming another account is refused.
  const other = await setupAccount(await makeServer());
  const wrong = joinRequest({ ...openJoinRequest(request), join: newJoinId(), account: other.id });
  r = await s.call("POST", "/v1/joins", {
    token: first.j.session,
    body: { request: wrong, commitment: joinCommitment(first.j.eph.publicKey, wrong) },
  });
  expect(r.status).toBe(400);
});

test("a long-poll opened before its device was revoked answers 401, not the change", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const tablet = await pair(s, acct, "tablet", "device", await signIn(s));
  const { j } = await ask(s, acct);
  const list = await s.call("GET", "/v1/joins", { token: tablet.token });
  const listWait = s.call("GET", `/v1/joins?after=${list.json.cursor}&wait=30`, {
    token: tablet.token,
  });
  const oneWait = s.call("GET", `/v1/joins/${j.id}?after=${list.json.cursor}&wait=30`, {
    token: tablet.token,
  });
  expect((await revoke(s, acct, "tablet")).status).toBe(201);
  // A change both polls wait for: a new request, and the first one cancelled.
  await ask(s, acct);
  expect((await s.call("DELETE", `/v1/joins/${j.id}`, { token: phone(acct) })).status).toBe(204);
  const [listed, one] = await Promise.all([listWait, oneWait]);
  expect(listed.status).toBe(401);
  expect(listed.json?.joins).toBeUndefined();
  expect(one.status).toBe(401);
  expect(one.json?.join).toBeUndefined();
});
