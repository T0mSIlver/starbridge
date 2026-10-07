import { expect, test } from "bun:test";
import { type Decision, open, type Run, type SealedItem, seal } from "@starbridge/protocol";
import { DEFAULT_LIMITS, type Limits } from "../src/limits";
import { sweepStorage } from "../src/retention";
import {
  type Actor,
  at,
  directory,
  makeServer,
  pair,
  setupAccount,
  signIn,
} from "../test-support/app";

async function setup(limits: Partial<Limits> = {}) {
  const s = await makeServer({ limits: { ...DEFAULT_LIMITS, ...limits } });
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  const otherbox = await pair(s, acct, "otherbox", "machine");
  return { s, acct, phone: acct.device, devbox, otherbox };
}

const key = (a: Actor) => ({ id: a.id, signKey: a.keys.sign.privateKey });

function run(from: Actor, to: Actor, id: string, update: Partial<Run> = {}): SealedItem {
  const body: Run = {
    v: 1,
    id,
    to: [to.id],
    title: "Mac e2e",
    reason: "uses your session and keyboard",
    source: { machine: from.id, project: "starbridge", session: "s1" },
    startedAt: at,
    at,
    ...update,
  };
  return seal("run", body, key(from), [to.member]);
}

test("a run re-posted under its id replaces the earlier post and passes every cursor", async () => {
  const { s, phone, devbox } = await setup();
  const post = (item: SealedItem) =>
    s.call("POST", "/v1/items", { token: devbox.token, body: item });
  expect((await post(run(devbox, phone, "r1"))).status).toBe(201);
  const first = await s.call("GET", "/v1/items?kind=run", { token: phone.token });
  expect(first.json.items).toHaveLength(1);

  const done = "2026-10-04T12:02:00Z";
  const update = run(devbox, phone, "r1", { at: done, exit: { code: 0, at: done } });
  expect((await post(update)).status).toBe(201);
  const after = await s.call("GET", `/v1/items?kind=run&after=${first.json.cursor}`, {
    token: phone.token,
  });
  expect(after.json.items).toHaveLength(1);
  const all = await s.call("GET", "/v1/items?kind=run", { token: phone.token });
  expect(all.json.items).toHaveLength(1);
  const opened = open(
    all.json.items[0].item,
    { id: phone.id, box: phone.keys.box },
    await directory(s, phone.token),
  );
  expect(opened.body).toMatchObject({ id: "r1", exit: { code: 0 } });
});

test("only the machine that posted a run updates it, and no other kind takes its id", async () => {
  const { s, phone, devbox, otherbox } = await setup();
  expect(
    (await s.call("POST", "/v1/items", { token: devbox.token, body: run(devbox, phone, "r1") }))
      .status,
  ).toBe(201);
  const stolen = await s.call("POST", "/v1/items", {
    token: otherbox.token,
    body: run(otherbox, phone, "r1"),
  });
  expect(stolen.json.error).toBe("duplicate-id");

  const decision: Decision = {
    v: 1,
    id: "r1",
    to: [phone.id],
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: [],
    source: { machine: devbox.id, project: "starbridge", session: "s1" },
  };
  const reused = await s.call("POST", "/v1/items", {
    token: devbox.token,
    body: seal("decision", decision, key(devbox), [phone.member]),
  });
  expect(reused.json.error).toBe("duplicate-id");

  const fromDevice = await s.call("POST", "/v1/items", {
    token: phone.token,
    body: run(phone, devbox, "r2"),
  });
  expect(fromDevice.status).toBe(403);
});

test("an account holds at most `runs` runs, and updates still pass at the cap", async () => {
  const { s, phone, devbox } = await setup({ runs: 2 });
  const post = (item: SealedItem) =>
    s.call("POST", "/v1/items", { token: devbox.token, body: item });
  expect((await post(run(devbox, phone, "r1"))).status).toBe(201);
  expect((await post(run(devbox, phone, "r2"))).status).toBe(201);
  const third = await post(run(devbox, phone, "r3"));
  expect(third.status).toBe(409);
  expect(third.json.error).toBe("too-many-items");
  expect((await post(run(devbox, phone, "r2", { at: "2026-10-04T12:01:00Z" }))).status).toBe(201);
});

test("a run update's boxes stay within runBytes", async () => {
  const { s, phone, devbox } = await setup({ runBytes: 200 });
  const r = await s.call("POST", "/v1/items", {
    token: devbox.token,
    body: run(devbox, phone, "r1"),
  });
  expect(r.status).toBe(413);
  expect(r.json.error).toBe("too-large");
});

test("runBytes counts per device, so a run reaches every device", async () => {
  const probe = await setup();
  const box = run(probe.devbox, probe.phone, "r0").boxes[0]?.box.length ?? 0;
  const { s, acct, phone, devbox } = await setup({ runBytes: Math.ceil(box * 1.2) });
  const laptop = await pair(s, acct, "laptop", "device", await signIn(s));
  const body: Run = {
    v: 1,
    id: "r1",
    to: [phone.id, laptop.id],
    title: "Mac e2e",
    reason: "uses your session and keyboard",
    source: { machine: devbox.id, project: "starbridge", session: "s1" },
    startedAt: at,
    at,
  };
  const item = seal("run", body, key(devbox), [phone.member, laptop.member]);
  const r = await s.call("POST", "/v1/items", { token: devbox.token, body: item });
  expect(r.status).toBe(201);

  // Within the total for two devices, but one device's box is over its share (#719).
  const [a, b] = item.boxes as [{ to: string; box: string }, { to: string; box: string }];
  const lopsided = {
    ...item,
    boxes: [
      { ...a, box: a.box + "A".repeat(Math.ceil(box / 2)) },
      { ...b, box: b.box.slice(0, Math.floor(box / 2)) },
    ],
  };
  const big = await s.call("POST", "/v1/items", { token: devbox.token, body: lopsided });
  expect([big.status, big.json.error]).toEqual([413, "too-large"]);
});

test("runs are dropped a day after their last update", async () => {
  const { s, phone, devbox } = await setup();
  await s.call("POST", "/v1/items", { token: devbox.token, body: run(devbox, phone, "r1") });
  const count = async () =>
    (await s.call("GET", "/v1/items?kind=run", { token: phone.token })).json.items.length;
  await sweepStorage(s.deps.db, DEFAULT_LIMITS, Date.now() + 23 * 3_600_000);
  expect(await count()).toBe(1);
  await sweepStorage(s.deps.db, DEFAULT_LIMITS, Date.now() + 25 * 3_600_000);
  expect(await count()).toBe(0);
});
