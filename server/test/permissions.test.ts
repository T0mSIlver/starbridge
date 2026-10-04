import { beforeEach, expect, test } from "bun:test";
import {
  hashInput,
  open,
  type Permission,
  type PermissionAnswer,
  type SealedItem,
  type Settled,
  seal,
} from "@starbridge/protocol";
import {
  type Account,
  type Actor,
  at,
  directory,
  makeServer,
  pair,
  type Server,
  setupAccount,
  signIn,
} from "../test-support/app";

let s: Server;
let acct: Account;
let phone: Actor;
let laptop: Actor;
let devbox: Actor;
let otherbox: Actor;

beforeEach(async () => {
  s = await makeServer();
  acct = await setupAccount(s);
  phone = acct.device;
  laptop = await pair(s, acct, "laptop", "device", await signIn(s));
  devbox = await pair(s, acct, "devbox", "machine");
  otherbox = await pair(s, acct, "otherbox", "machine");
});

const key = (a: Actor) => ({ id: a.id, signKey: a.keys.sign.privateKey });
let n = 0;
const input = '{"command":"git push"}';

function permission(from: Actor = devbox): SealedItem {
  const body: Permission = {
    v: 1,
    id: `p${++n}`,
    to: [phone.id, laptop.id],
    createdAt: at,
    agent: "claude-code",
    tool: "Bash",
    summary: "git push",
    input,
    inputHash: hashInput(input),
    suggestions: [],
    expiresAt: "2026-10-04T12:09:30Z",
    source: { machine: "devbox", project: "starbridge", session: "s1" },
  };
  return seal("permission", body, key(from), [phone.member, laptop.member]);
}

function answer(p: SealedItem, by: Actor = phone, to: Actor = devbox): SealedItem {
  const body: PermissionAnswer = {
    v: 1,
    id: `pa${++n}`,
    permissionId: p.id,
    to: to.id,
    answeredAt: at,
    behavior: "allow",
    scope: "once",
    inputHash: hashInput(input),
  };
  return seal("permission-answer", body, key(by), [to.member]);
}

function settled(p: SealedItem, from: Actor = devbox): SealedItem {
  const body: Settled = {
    v: 1,
    id: `st${++n}`,
    permissionId: p.id,
    to: [phone.id, laptop.id],
    outcome: "keyboard",
    at,
  };
  return seal("settled", body, key(from), [phone.member, laptop.member]);
}

const post = (who: Actor, item: SealedItem) =>
  s.call("POST", "/v1/items", { token: who.token, body: item });
const openList = async (who: Actor) =>
  (await s.call("GET", "/v1/items?kind=permission&open=1", { token: who.token })).json.items.map(
    (x: { item: SealedItem }) => x.item.id,
  );

test("a device's answer reaches the machine's inbox and closes the prompt for every device", async () => {
  const p = permission();
  expect((await post(devbox, p)).status).toBe(201);
  expect(await openList(laptop)).toEqual([p.id]);
  expect((await post(phone, answer(p))).status).toBe(201);
  expect(await openList(laptop)).toEqual([]);

  const inbox = await s.call("GET", "/v1/answers", { token: devbox.token });
  expect(inbox.json.items).toHaveLength(1);
  const opened = open(
    inbox.json.items[0].item,
    { id: devbox.id, box: devbox.keys.box },
    await directory(s, devbox.token),
  );
  expect(opened.body).toMatchObject({ permissionId: p.id, behavior: "allow" });

  const again = await post(laptop, answer(p, laptop));
  expect(again.status).toBe(409);
  expect(again.json.error).toBe("already-answered");
  // After the answer the machine still reports the outcome, once.
  expect((await post(devbox, settled(p))).status).toBe(201);
  expect((await post(devbox, settled(p))).json.error).toBe("already-settled");
});

test("a settled notice closes the prompt and refuses later answers", async () => {
  const p = permission();
  await post(devbox, p);
  const before = await s.call("GET", "/v1/items?kind=permission,settled", { token: phone.token });
  expect((await post(devbox, settled(p))).status).toBe(201);
  const after = await s.call(
    "GET",
    `/v1/items?kind=permission,settled&after=${before.json.cursor}`,
    { token: phone.token },
  );
  expect(after.json.items.map((x: { item: SealedItem }) => x.item.kind).sort()).toEqual([
    "permission",
    "settled",
  ]);
  expect(await openList(phone)).toEqual([]);
  expect((await post(phone, answer(p))).json.error).toBe("already-answered");
});

test("a prompt cannot be answered after 10 minutes", async () => {
  const p = permission();
  await post(devbox, p);
  s.deps.db
    .query("UPDATE items SET received_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 60_000 - 1000).toISOString(), p.id);
  expect(await openList(phone)).toEqual([]);
  const r = await post(phone, answer(p));
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("expired");
});

test("roles, recipients and references are checked", async () => {
  const p = permission();
  expect((await post(phone, p)).status).toBe(403); // devices do not ask
  await post(devbox, p);
  expect((await post(devbox, answer(p))).status).toBe(403); // machines do not answer
  expect((await post(phone, settled(p))).status).toBe(403); // devices do not settle
  // An answer goes to the machine that asked; a settled notice comes from it.
  expect((await post(phone, answer(p, phone, otherbox))).status).toBe(404);
  expect((await post(otherbox, settled(p, otherbox))).status).toBe(404);
  // A permission answer cannot answer a decision id, nor a settled notice name a missing one.
  expect((await post(phone, answer({ ...p, id: "missing" }))).status).toBe(404);
  // Machines list only answers addressed to them; devices list only what machines sign.
  expect(
    (await s.call("GET", "/v1/items?kind=permission-answer", { token: phone.token })).status,
  ).toBe(400);
});

test("a permission pushes the device's box, an answer pushes answered", async () => {
  const sent: { to: string[]; payload: string }[] = [];
  s.deps.push.notify = (_account: string, to: string[], payload: (d: string) => string) => {
    sent.push({ to, payload: payload(to[0] as string) });
  };
  const p = permission();
  await post(devbox, p);
  await post(phone, answer(p));
  await post(devbox, settled(p));
  const kinds = sent.map((x) => JSON.parse(x.payload));
  expect(kinds.map((k) => k.kind)).toEqual(["permission", "answered", "settled"]);
  expect(kinds[0].box).toBeString();
  expect(kinds[1].id).toBe(p.id);
  expect(kinds[2].re).toBe(p.id);
});
