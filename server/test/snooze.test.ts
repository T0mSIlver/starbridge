import { beforeEach, expect, test } from "bun:test";
import {
  type Answer,
  type Decision,
  type SealedItem,
  type Snooze,
  seal,
  type Waiting,
} from "@starbridge/protocol";
import { DEFAULT_LIMITS } from "../src/limits";
import { sweepStorage } from "../src/retention";
import { wakeSnoozes } from "../src/snooze";
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
let otherbox: Actor;
let sent: { to: string[]; payload: Record<string, unknown> }[];

beforeEach(async () => {
  s = await makeServer();
  acct = await setupAccount(s);
  phone = acct.device;
  web = await pair(s, acct, "web", "device", await signIn(s));
  devbox = await pair(s, acct, "devbox", "machine");
  otherbox = await pair(s, acct, "otherbox", "machine");
  sent = [];
  s.deps.push.notify = (_account: string, to: string[], payload: (d: string) => string) => {
    sent.push({ to, payload: JSON.parse(payload(to[0] as string)) });
  };
});

const key = (a: Actor) => ({ id: a.id, signKey: a.keys.sign.privateKey });
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
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

function snooze(d: SealedItem, until: string, from: Actor = phone, to = [devbox, phone, web]) {
  const body: Snooze = {
    v: 1,
    id: `z${++n}`,
    decisionId: d.id,
    to: to.map((a) => a.id),
    until,
    at: new Date().toISOString(),
  };
  return seal(
    "snooze",
    body,
    key(from),
    to.map((a) => a.member),
  );
}

function waiting(d: SealedItem, state: Waiting["state"]): SealedItem {
  const body: Waiting = {
    v: 1,
    id: `w-${d.id}`,
    decisionId: d.id,
    to: [phone.id, web.id],
    at,
    state,
  };
  return seal("waiting", body, key(devbox), [phone.member, web.member]);
}

function answer(d: SealedItem): SealedItem {
  const body: Answer = {
    v: 1,
    id: `a${++n}`,
    decisionId: d.id,
    to: devbox.id,
    answeredAt: at,
    choice: "yes",
  };
  return seal("answer", body, key(phone), [devbox.member]);
}

const post = (who: Actor, item: SealedItem) =>
  s.call("POST", "/v1/items", { token: who.token, body: item });
const list = async (who: Actor, query: string) =>
  (await s.call("GET", `/v1/items?${query}`, { token: who.token })).json.items as {
    item: SealedItem;
  }[];
const inbox = async (query = "") =>
  (await s.call("GET", `/v1/answers?wait=0${query}`, { token: devbox.token })).json.items as {
    item: SealedItem;
  }[];
const wake = (hours: number) =>
  wakeSnoozes(s.deps.db, s.deps.push, 3072, Date.now() + hours * HOUR);

test("a snooze reaches every device and the machine, and leaves its decision open", async () => {
  const d = decision();
  await post(devbox, d);
  sent = [];
  const z = snooze(d, inHours(3));
  expect((await post(phone, z)).status).toBe(201);

  // The other device hears of it at once, with its wakeAt; no "answered" push.
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toEqual([web.id]);
  expect(sent[0]?.payload).toMatchObject({ kind: "snooze", id: z.id, re: d.id, wakeAt: z.wakeAt });
  expect((await list(web, "kind=snooze")).map((x) => x.item)).toEqual([
    { ...z, boxes: z.boxes.filter((b) => b.to === web.id) },
  ]);
  expect((await list(web, "kind=decision&open=1")).map((x) => x.item.id)).toEqual([d.id]);
  // Machines read it only when they ask for it.
  expect(await inbox()).toEqual([]);
  expect((await inbox("&kinds=answer,permission-answer,snooze")).map((x) => x.item.id)).toEqual([
    z.id,
  ]);
});

test("every snooze is kept, each returns at its time, and none can be replayed", async () => {
  const d = decision();
  await post(devbox, d);
  const first = snooze(d, inHours(3));
  await post(phone, first);
  const later = snooze(d, inHours(5), web);
  expect((await post(web, later)).status).toBe(201);
  expect((await list(phone, "kind=snooze")).map((x) => x.item.id)).toEqual([first.id, later.id]);
  expect((await post(phone, first)).json.error).toBe("duplicate-id");
  sent = [];
  wake(6);
  expect(sent.map((p) => p.payload.id)).toEqual([first.id, later.id]);
});

test("a snooze must return before the question is dropped", async () => {
  const d = decision();
  await post(devbox, d);
  s.deps.db
    .query("UPDATE items SET received_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 29 * 24 * HOUR).toISOString(), d.id);
  expect((await post(phone, snooze(d, inHours(23)))).status).toBe(201);
  expect((await post(phone, snooze(d, inHours(25)))).json.error).toBe("bad-schema");
});

test("a snooze is refused when it goes astray, has no time, runs past 7 days or comes late", async () => {
  const d = decision();
  await post(devbox, d);
  const astray = await post(phone, snooze(d, inHours(1), phone, [devbox, otherbox, phone]));
  expect([astray.status, astray.json.error]).toEqual([400, "unknown-recipient"]);
  const { wakeAt: _, ...bare } = snooze(d, inHours(1));
  expect((await post(phone, bare)).json.error).toBe("bad-schema");
  expect((await post(phone, snooze(d, inHours(7 * 24 + 1)))).json.error).toBe("bad-schema");
  expect((await post(phone, { ...answer(d), wakeAt: inHours(1) })).json.error).toBe("bad-schema");
  await post(phone, answer(d));
  const late = await post(web, snooze(d, inHours(1), web));
  expect([late.status, late.json.error]).toEqual([409, "already-answered"]);
});

test("at its time a snooze is pushed to every device once", async () => {
  const d = decision();
  await post(devbox, d);
  const z = snooze(d, inHours(2));
  await post(phone, z);
  sent = [];
  wake(1);
  expect(sent).toEqual([]);
  wake(2);
  expect(sent.map((p) => [p.to, p.payload.kind, p.payload.wakeAt])).toEqual([
    [[phone.id, web.id], "snooze", z.wakeAt],
  ]);
  wake(3);
  expect(sent).toHaveLength(1);
});

test("an answer cancels every pending push; back now leaves them to the devices", async () => {
  const answered = decision();
  await post(devbox, answered);
  await post(phone, snooze(answered, inHours(2)));
  expect((await post(phone, answer(answered))).status).toBe(201);
  const back = decision();
  await post(devbox, back);
  const first = snooze(back, inHours(2));
  await post(phone, first);
  await post(phone, snooze(back, new Date().toISOString()));
  sent = [];
  wake(3);
  // Only the earlier snooze of the question brought back: devices know a newer one and drop it.
  expect(sent.map((p) => p.payload.id)).toEqual([first.id]);
});

test("a waiting flip on a snoozed decision pushes nothing", async () => {
  const d = decision();
  await post(devbox, d);
  await post(phone, snooze(d, inHours(2)));
  sent = [];
  expect((await post(devbox, waiting(d, "waiting"))).status).toBe(201);
  expect(sent).toEqual([]);
  // Back now: flips push again.
  await post(phone, snooze(d, new Date().toISOString()));
  sent = [];
  await post(devbox, waiting(d, "working"));
  expect(sent.map((p) => p.payload.kind)).toEqual(["waiting"]);
});

test("a snooze goes with its decision", async () => {
  const d = decision();
  await post(devbox, d);
  await post(phone, snooze(d, inHours(2)));
  sweepStorage(s.deps.db, DEFAULT_LIMITS, Date.now() + 31 * 86_400_000);
  expect(await list(phone, "kind=snooze")).toEqual([]);
});
