import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Answer, type Decision, type SealedItem, seal } from "@starbridge/protocol";
import { openDb } from "../src/db";
import { aggregate, closeDays, dayOf, report, Usage } from "../src/usage";
import { type Actor, at, makeServer, pair, setupAccount, signIn } from "../test-support/app";

function decision(id: string, from: Actor, to: Actor[]) {
  const body: Decision = {
    v: 1,
    id,
    to: to.map((a) => a.id),
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    source: { machine: "devbox", project: "starbridge", session: "s1" },
  };
  return seal(
    "decision",
    body,
    { id: from.id, signKey: from.keys.sign.privateKey },
    to.map((a) => a.member),
  );
}

function answer(d: SealedItem, by: Actor, machine: Actor) {
  const body: Answer = {
    v: 1,
    id: `a-${d.id}`,
    decisionId: d.id,
    to: machine.id,
    answeredAt: at,
    choice: "yes",
  };
  return seal("answer", body, { id: by.id, signKey: by.keys.sign.privateKey }, [machine.member]);
}

test("a day's requests become counts; closing the day keeps only the counts", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const phone = acct.device;
  const laptop = await pair(s, acct, "laptop", "device", await signIn(s));
  const devbox = await pair(s, acct, "devbox", "machine");
  await s.call("POST", "/v1/push/subscriptions", {
    token: phone.token,
    body: { type: "fcm", endpoint: "tok-1" },
  });

  const post = (item: unknown, opts: { token?: string; headers?: Record<string, string> }) =>
    s.call("POST", "/v1/items", { ...opts, body: item });
  const d1 = decision("d1", devbox, [phone, laptop]);
  const d2 = decision("d2", devbox, [phone, laptop]);
  expect((await post(d1, { token: devbox.token })).status).toBe(201);
  expect((await post(d2, { token: devbox.token })).status).toBe(201);
  // The phone answers with its bearer token, the laptop's page with the session cookie.
  expect((await post(answer(d1, phone, devbox), { token: phone.token })).status).toBe(201);
  const cookie = { cookie: `sb_session=${laptop.token}`, origin: "http://localhost" };
  expect((await post(answer(d2, laptop, devbox), { headers: cookie })).status).toBe(201);
  await s.deps.push.idle();

  const { db } = s.deps;
  const today = dayOf(Date.now());
  const counts = aggregate(db, today);
  expect(counts).toMatchObject({
    "active.accounts": 1,
    "active.machines": 1,
    "active.devices.android": 1,
    "active.devices.web": 1,
    "items.decision": 2,
    "items.answer": 2,
    "answered.decision.seconds": 2,
    "answered.by.android": 1,
    "answered.by.web": 1,
    // Two decisions and two "answered" notices to the phone; with no FCM credentials and no
    // relay in tests, none has a route.
    "push.fcm.no-route": 4,
    "total.accounts": 1,
    "new.accounts": 1,
    "total.machines": 1,
    "total.devices": 2,
    "total.push-targets.fcm": 1,
  });
  expect(counts["answered.decision.seconds.p50"]).toBeGreaterThanOrEqual(0);

  closeDays(db, Date.now() + 86_400_000);
  expect(db.query("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 0 });
  const kept = db.query("SELECT metric, value FROM usage_days WHERE day = ?").all(today) as {
    metric: string;
    value: number;
  }[];
  expect(Object.fromEntries(kept.map((r) => [r.metric, r.value]))).toEqual(counts);
  // Nothing kept names an account or a member.
  const ids = [acct.id, phone.id, laptop.id, devbox.id];
  for (const r of kept) expect(ids.some((id) => r.metric.includes(id))).toBe(false);
});

test("each subject counts once a day; values give nearest-rank percentiles", () => {
  const db = openDb(":memory:");
  let now = Date.parse("2026-10-05T10:00:00Z");
  const usage = new Usage(db, () => now);
  for (let i = 0; i < 3; i++) usage.record("active.accounts", "acct-1");
  usage.record("active.accounts", "acct-2");
  for (let v = 1; v <= 10; v++) usage.record("answered.decision.seconds", null, v);
  now += 86_400_000;
  usage.record("active.accounts", "acct-1");

  expect(aggregate(db, "2026-10-05")).toMatchObject({
    "active.accounts": 2,
    "answered.decision.seconds": 10,
    "answered.decision.seconds.p50": 5,
    "answered.decision.seconds.p90": 9,
  });
  expect(aggregate(db, "2026-10-06")["active.accounts"]).toBe(1);

  closeDays(db, now);
  const rows = report(db, 3, now);
  expect(rows.map((r) => r.day)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"]);
  // A day the server did not run has no counts; a closed day reads from usage_days.
  expect(rows[0]?.metrics).toEqual({});
  expect(rows[1]?.metrics["answered.decision.seconds.p90"]).toBe(9);
  expect(rows[2]?.metrics["active.accounts"]).toBe(1);
});

test("no route serves the usage counts, even to the owner", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  expect(s.app.routes.filter((r) => /usage|stats|admin/.test(r.path))).toEqual([]);
  for (const path of ["/v1/usage", "/v1/stats", "/v1/admin/usage"])
    expect((await s.call("GET", path, { token: acct.device.token })).status).toBe(404);
});

test("`usage [days]` prints the counts from the database file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starbridge-usage-"));
  const dbPath = join(dir, "starbridge.db");
  const db = openDb(dbPath);
  new Usage(db).record("items.decision");
  db.close();
  const proc = Bun.spawnSync([process.execPath, "src/main.ts", "usage", "2"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain(dayOf(Date.now()).slice(5));
  expect(out).toMatch(/items\.decision +- +1/);
});

test("members with the same id in two accounts count as two", () => {
  const db = openDb(":memory:");
  const usage = new Usage(db);
  usage.seen({ role: "machine", account: "a1", member: "devbox" });
  usage.seen({ role: "machine", account: "a2", member: "devbox" });
  for (const account of ["a1", "a2"])
    usage.seen({ role: "device", account, member: "phone", session: account, client: "android" });
  const day = aggregate(db, dayOf(Date.now()));
  expect(day["active.machines"]).toBe(2);
  expect(day["active.devices.android"]).toBe(2);
});
