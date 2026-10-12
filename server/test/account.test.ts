import { expect, test } from "bun:test";
import {
  type Answer,
  type Decision,
  generateMemberKeys,
  joinCommitment,
  joinRequest,
  newJoinId,
  newJoinKeyPair,
  publicKeys,
  seal,
} from "@starbridge/protocol";
import { createSession, setSuspended } from "../src/auth";
import { ACCOUNT_TABLES } from "../src/routes/account";
import {
  type Account,
  at,
  makeServer,
  pair,
  revoke,
  type Server,
  setupAccount,
  signIn,
} from "../test-support/app";

/** Every row of every table that names `account` in any column. */
function rowsNaming(s: Server, account: string): string[] {
  const db = s.deps.db;
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  const found: string[] = [];
  for (const { name } of tables)
    for (const row of db.query(`SELECT * FROM ${name}`).all() as Record<string, unknown>[])
      if (Object.values(row).some((v) => typeof v === "string" && v.includes(account)))
        found.push(`${name}: ${JSON.stringify(row)}`);
  return found;
}

/** An account with a second device, a machine, a decision and its answer, a push target, settings and an open join. */
async function busyAccount(s: Server, session?: string) {
  const acct = await setupAccount(s, "phone", session);
  const laptop = await pair(s, acct, "laptop", "device", await signIn(s));
  const devbox = await pair(s, acct, "devbox", "machine");
  // A revoked device leaves its session in revoked_sessions.
  await pair(s, acct, "tablet", "device", await signIn(s));
  expect((await revoke(s, acct, "tablet")).status).toBe(201);
  const body: Decision = {
    v: 1,
    id: `d-${acct.id}`,
    to: [acct.device.id, laptop.id],
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    source: { machine: "devbox", project: "starbridge", session: "s1" },
  };
  const d = seal("decision", body, { id: devbox.id, signKey: devbox.keys.sign.privateKey }, [
    acct.device.member,
    laptop.member,
  ]);
  expect((await s.call("POST", "/v1/items", { token: devbox.token, body: d })).status).toBe(201);
  const reply: Answer = {
    v: 1,
    id: `a-${acct.id}`,
    decisionId: d.id,
    to: devbox.id,
    answeredAt: at,
    choice: "yes",
  };
  const a = seal(
    "answer",
    reply,
    { id: acct.device.id, signKey: acct.device.keys.sign.privateKey },
    [devbox.member],
  );
  expect((await s.call("POST", "/v1/items", { token: acct.device.token, body: a })).status).toBe(
    201,
  );
  const sub = {
    type: "webpush",
    endpoint: "https://push.example.com/x",
    keys: { p256dh: "k", auth: "a" },
  };
  expect(
    (await s.call("POST", "/v1/push/subscriptions", { token: acct.device.token, body: sub }))
      .status,
  ).toBe(201);
  expect(
    (await s.call("PUT", "/v1/settings", { token: acct.device.token, body: { pushHold: 10 } }))
      .status,
  ).toBe(200);
  expect(
    (await s.call("PUT", "/v1/presence", { token: devbox.token, body: { present: true } })).status,
  ).toBe(204);
  const joiner = await signIn(s);
  const join = newJoinId();
  const request = joinRequest({
    v: 1,
    join,
    account: acct.id,
    id: `w_${join}`,
    name: "New browser",
    ...publicKeys(generateMemberKeys()),
    at,
  });
  const key = newJoinKeyPair();
  const commitment = joinCommitment(key.publicKey, request);
  expect(
    (await s.call("POST", "/v1/joins", { token: joiner, body: { request, commitment } })).status,
  ).toBe(201);
  setSuspended(s.deps.db, acct.id, true);
  return { acct, laptop, devbox, joiner };
}

test("deleting the account leaves no row naming it and signs out every session and machine", async () => {
  const s = await makeServer();
  const { acct, laptop, devbox, joiner } = await busyAccount(s);
  // Another account, which the deletion leaves alone.
  s.deps.db.query("INSERT INTO accounts (id, created_at) VALUES ('a_other', ?)").run(at);
  const other: Account = await setupAccount(s, "phone", createSession(s.deps.db, "a_other", 50));
  const before = rowsNaming(s, "a_other");
  // Each table that holds accounts' rows holds some of this one's, and the deletion covers it.
  const holding = new Set(rowsNaming(s, acct.id).map((r) => r.split(":")[0]));
  expect([...holding].sort()).toEqual([...ACCOUNT_TABLES, "accounts", "usage_events"].sort());

  // The machine's answer long-poll ends at once.
  const read = await s.call("GET", "/v1/answers", { token: devbox.token });
  const poll = s.call("GET", `/v1/answers?wait=30&after=${read.json.cursor}`, {
    token: devbox.token,
  });
  await Bun.sleep(10);
  expect(s.deps.answers.count(`${acct.id}/${devbox.id}`)).toBe(1);
  const r = await s.call("DELETE", "/v1/account", { token: laptop.token });
  expect(r.status).toBe(204);
  expect((await poll).status).toBe(401);

  expect(rowsNaming(s, acct.id)).toEqual([]);
  expect(rowsNaming(s, "a_other")).toEqual(before);
  // Today's activity still counts, under subjects that name neither the account nor a member.
  const subjects = s.deps.db
    .query("SELECT DISTINCT subject FROM usage_events WHERE subject LIKE 'gone_%'")
    .all() as { subject: string }[];
  expect(subjects.length).toBeGreaterThan(3);
  for (const { subject } of subjects) expect(subject).not.toContain("/");
  for (const token of [acct.device.token, laptop.token, devbox.token, joiner])
    expect((await s.call("GET", "/v1/me", { token })).status).toBe(401);
  expect(s.deps.presence.present(acct.id)).toEqual([]);
  expect((await s.call("GET", "/v1/me", { token: other.device.token })).status).toBe(200);
});

test("an unpaired session may delete its account; signing in again starts a new one", async () => {
  const s = await makeServer();
  const session = await signIn(s);
  const first = (await s.call("GET", "/v1/me", { token: session })).json.account;
  expect((await s.call("DELETE", "/v1/account", { token: session })).status).toBe(204);
  expect(rowsNaming(s, first)).toEqual([]);
  const again = await signIn(s);
  expect((await s.call("GET", "/v1/me", { token: again })).json.account).not.toBe(first);
});

test("one address deletes at most 3 accounts an hour", async () => {
  const s = await makeServer();
  for (let i = 0; i < 3; i++)
    expect((await s.call("DELETE", "/v1/account", { token: await signIn(s) })).status).toBe(204);
  const r = await s.call("DELETE", "/v1/account", { token: await signIn(s) });
  expect(r.status).toBe(429);
  expect(r.json.error).toBe("rate-limited");
});

test("a machine cannot delete the account, nor can anyone signed out", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  expect((await s.call("DELETE", "/v1/account", { token: devbox.token })).status).toBe(403);
  expect((await s.call("DELETE", "/v1/account")).status).toBe(401);
  expect((await s.call("GET", "/v1/me", { token: acct.device.token })).status).toBe(200);
});
