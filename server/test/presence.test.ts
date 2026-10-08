import { beforeEach, expect, test } from "bun:test";
import {
  type Answer,
  type Decision,
  PRESENCE_VALID_MS,
  type SealedItem,
  type Settled,
  type Snooze,
  seal,
  type Waiting,
} from "@starbridge/protocol";
import { releaseHolds } from "../src/presence";
import {
  type Account,
  type Actor,
  at,
  makeServer,
  pair,
  type Server,
  setupAccount,
  signIn,
} from "../test-support/app";

let s: Server;
let acct: Account;
let phone: Actor;
let web: Actor;
let devbox: Actor;
let sent: { to: string[]; payload: Record<string, unknown> }[];

beforeEach(async () => {
  s = await makeServer();
  acct = await setupAccount(s);
  phone = acct.device;
  web = await pair(s, acct, "web", "device", await signIn(s));
  devbox = await pair(s, acct, "devbox", "machine");
  sent = [];
  s.deps.push.notify = (_account: string, to: string[], payload: (d: string) => string) => {
    if (to.length > 0) sent.push({ to, payload: JSON.parse(payload(to[0] as string)) });
  };
});

const key = (a: Actor) => ({ id: a.id, signKey: a.keys.sign.privateKey });
let n = 0;

function decision(): SealedItem {
  const body: Decision = {
    v: 1,
    id: `d${++n}`,
    to: [phone.id, web.id],
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    source: { machine: "devbox", project: "starbridge", session: "s1" },
  };
  return seal("decision", body, key(devbox), [phone.member, web.member]);
}

function waiting(d: SealedItem): SealedItem {
  const body: Waiting = {
    v: 1,
    id: `w-${d.id}`,
    decisionId: d.id,
    to: [phone.id, web.id],
    at,
    state: "waiting",
  };
  return seal("waiting", body, key(devbox), [phone.member, web.member]);
}

function answer(d: SealedItem, from: Actor): SealedItem {
  const body: Answer = {
    v: 1,
    id: `a${++n}`,
    decisionId: d.id,
    to: devbox.id,
    answeredAt: at,
    choice: "yes",
  };
  return seal("answer", body, key(from), [devbox.member]);
}

function settled(d: SealedItem): SealedItem {
  const body: Settled = {
    v: 1,
    id: `s${++n}`,
    itemId: d.id,
    to: [phone.id, web.id],
    at,
    outcome: "elsewhere",
  };
  return seal("settled", body, key(devbox), [phone.member, web.member]);
}

function snooze(d: SealedItem): SealedItem {
  const body: Snooze = {
    v: 1,
    id: `z${++n}`,
    decisionId: d.id,
    to: [devbox.id, phone.id, web.id],
    until: new Date(Date.now() + 3_600_000).toISOString(),
    at: new Date().toISOString(),
  };
  return seal("snooze", body, key(web), [devbox.member, phone.member, web.member]);
}

const post = (who: Actor, item: SealedItem) =>
  s.call("POST", "/v1/items", { token: who.token, body: item });
const present = (who: Actor, yes = true) =>
  s.call("PUT", "/v1/presence", { token: who.token, body: { present: yes } });
const heldUntil = async (who: Actor, id: string) =>
  (
    (await s.call("GET", "/v1/items?kind=decision,waiting", { token: who.token })).json.items as {
      item: SealedItem;
      heldUntil?: string;
    }[]
  ).find((x) => x.item.id === id)?.heldUntil;
const release = (afterMs: number) =>
  releaseHolds(s.deps.db, s.deps.push, 3072, Date.now() + afterMs);
const pushed = () => sent.map((p) => [p.to, p.payload.kind, p.payload.id]);

test("with nobody present, a question pushes every device at once, as before", async () => {
  const d = decision();
  await post(devbox, d);
  expect(pushed()).toEqual([[[phone.id, web.id], "decision", d.id]]);
  expect(await heldUntil(phone, d.id)).toBeUndefined();
});

test("while a page is present, the other devices' push waits the hold, then goes if still open", async () => {
  expect((await present(web)).status).toBe(204);
  const d = decision();
  await post(devbox, d);
  // The present page hears at once; the phone lists it held and gets no push.
  expect(pushed()).toEqual([[[web.id], "decision", d.id]]);
  const due = await heldUntil(phone, d.id);
  expect(Date.parse(due as string) - Date.now()).toBeGreaterThan(29_000);
  expect(await heldUntil(web, d.id)).toBeUndefined();
  sent = [];
  release(10_000);
  expect(sent).toEqual([]);
  release(31_000);
  expect(pushed()).toEqual([[[phone.id], "decision", d.id]]);
  expect(await heldUntil(phone, d.id)).toBeUndefined();
  sent = [];
  release(60_000);
  expect(sent).toEqual([]);
});

test("a machine's presence holds every device; its answer at the keyboard means no push ever", async () => {
  await present(devbox);
  const d = decision();
  await post(devbox, d);
  expect(sent).toEqual([]);
  await post(devbox, settled(d));
  // The settled notice skips the devices that never heard of the question.
  expect(sent).toEqual([]);
  release(31_000);
  expect(sent).toEqual([]);
});

test("a device's answer during the hold skips the held devices and cancels their push", async () => {
  await present(web);
  const d = decision();
  await post(devbox, d);
  sent = [];
  expect((await post(web, answer(d, web))).status).toBe(201);
  expect(pushed()).toEqual([[[web.id], "answered", d.id]]);
  sent = [];
  // The machine then announces which answer won (#330): not to the phone, which never heard.
  await post(devbox, settled(d));
  expect(pushed()).toEqual([[[web.id], "settled", expect.any(String)]]);
  sent = [];
  release(31_000);
  expect(sent).toEqual([]);
});

test("a waiting flip is held too, and a snooze during the hold keeps it quiet", async () => {
  await present(web);
  const d = decision();
  await post(devbox, d);
  await post(devbox, waiting(d));
  expect(pushed()).toEqual([
    [[web.id], "decision", d.id],
    [[web.id], "waiting", `w-${d.id}`],
  ]);
  await post(web, snooze(d));
  sent = [];
  release(31_000);
  expect(sent).toEqual([]);
});

test("presence ends when its source says so or stops beating, and the hold time is the account's", async () => {
  await present(web);
  await present(web, false);
  await post(devbox, decision());
  expect(pushed()[0]?.[0]).toEqual([phone.id, web.id]);

  await present(web);
  s.deps.presence.beat(acct.id, web.id, true, Date.now() - PRESENCE_VALID_MS);
  sent = [];
  await post(devbox, decision());
  expect(pushed()[0]?.[0]).toEqual([phone.id, web.id]);

  // Off: presence holds nothing.
  const off = await s.call("PUT", "/v1/settings", { token: phone.token, body: { pushHold: 0 } });
  expect(off.json).toEqual({ pushHold: 0 });
  expect((await s.call("GET", "/v1/settings", { token: web.token })).json).toEqual({ pushHold: 0 });
  await present(web);
  sent = [];
  await post(devbox, decision());
  expect(pushed()[0]?.[0]).toEqual([phone.id, web.id]);

  await s.call("PUT", "/v1/settings", { token: phone.token, body: { pushHold: 120 } });
  sent = [];
  const d = decision();
  await post(devbox, d);
  expect(Date.parse((await heldUntil(phone, d.id)) as string) - Date.now()).toBeGreaterThan(
    119_000,
  );
});

test("presence takes one bit from members only, and settings only from devices", async () => {
  expect(
    (await s.call("PUT", "/v1/presence", { token: web.token, body: { present: true, idle: 3 } }))
      .status,
  ).toBe(204);
  expect(
    (await s.call("PUT", "/v1/presence", { token: web.token, body: { present: "yes" } })).status,
  ).toBe(400);
  expect((await s.call("PUT", "/v1/presence", { body: { present: true } })).status).toBe(401);
  const machine = await s.call("PUT", "/v1/settings", {
    token: devbox.token,
    body: { pushHold: 0 },
  });
  expect(machine.status).toBe(403);
  const tooLong = await s.call("PUT", "/v1/settings", {
    token: phone.token,
    body: { pushHold: 301 },
  });
  expect(tooLong.status).toBe(400);
});
