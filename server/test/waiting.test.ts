import { beforeEach, expect, test } from "bun:test";
import { type Decision, type SealedItem, seal, type Waiting } from "@starbridge/protocol";
import { DEFAULT_LIMITS } from "../src/limits";
import { sweepStorage } from "../src/retention";
import {
  type Account,
  type Actor,
  at,
  makeServer,
  pair,
  type Server,
  setupAccount,
} from "../test-support/app";

let s: Server;
let acct: Account;
let phone: Actor;
let devbox: Actor;
let otherbox: Actor;

beforeEach(async () => {
  s = await makeServer();
  acct = await setupAccount(s);
  phone = acct.device;
  devbox = await pair(s, acct, "devbox", "machine");
  otherbox = await pair(s, acct, "otherbox", "machine");
});

const key = (a: Actor) => ({ id: a.id, signKey: a.keys.sign.privateKey });
let n = 0;

function decision(): SealedItem {
  const body: Decision = {
    v: 1,
    id: `d${++n}`,
    to: [phone.id],
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    default: { action: "keep testing" },
    source: { machine: "devbox", project: "starbridge", session: "s1" },
  };
  return seal("decision", body, key(devbox), [phone.member]);
}

function waiting(
  d: SealedItem,
  state: Waiting["state"],
  id = `w-${d.id}`,
  from: Actor = devbox,
): SealedItem {
  const body: Waiting = { v: 1, id, decisionId: d.id, to: [phone.id], at, state };
  return {
    ...seal("waiting", body, key(from), [phone.member]),
    ...(state === "working" ? { quiet: true } : {}),
  };
}

const post = (who: Actor, item: SealedItem) =>
  s.call("POST", "/v1/items", { token: who.token, body: item });
const list = async (kinds: string, after?: string) =>
  (
    await s.call("GET", `/v1/items?kind=${kinds}${after ? `&after=${after}` : ""}`, {
      token: phone.token,
    })
  ).json;

test("a waiting state is re-posted under its id and leaves its decision open", async () => {
  const d = decision();
  await post(devbox, d);
  expect((await post(devbox, waiting(d, "working"))).status).toBe(201);
  const { cursor } = await list("decision,waiting");
  expect((await post(devbox, waiting(d, "waiting"))).status).toBe(201);

  const later = await list("decision,waiting", cursor);
  expect(later.items.map((x: { item: SealedItem }) => [x.item.kind, x.item.id])).toEqual([
    ["waiting", `w-${d.id}`],
  ]);
  const open = (await s.call("GET", "/v1/items?kind=decision&open=1", { token: phone.token })).json;
  expect(open.items.map((x: { item: SealedItem }) => x.item.id)).toEqual([d.id]);

  expect((await post(devbox, waiting(d, "waiting", "w-other"))).json.error).toBe("duplicate-id");
  expect((await post(otherbox, waiting(d, "waiting", "w-x", otherbox))).status).toBe(404);
});

test("an answered decision takes no waiting state", async () => {
  const d = decision();
  await post(devbox, d);
  const answer = seal(
    "answer",
    { v: 1, id: `a${++n}`, decisionId: d.id, to: devbox.id, answeredAt: at, choice: "yes" },
    key(phone),
    [devbox.member],
  );
  await post(phone, answer);
  expect((await post(devbox, waiting(d, "waiting"))).json.error).toBe("already-answered");
});

test("only a flip to waiting pushes", async () => {
  const sent: string[] = [];
  s.deps.push.notify = (_account: string, to: string[], payload: (d: string) => string) => {
    sent.push(payload(to[0] as string));
  };
  const d = decision();
  await post(devbox, d);
  await post(devbox, waiting(d, "working"));
  await post(devbox, waiting(d, "waiting"));
  expect(sent.map((p) => JSON.parse(p)).map((p) => [p.kind, p.re])).toEqual([
    ["decision", undefined],
    ["waiting", d.id],
  ]);
});

test("a waiting state goes with its decision", async () => {
  const d = decision();
  await post(devbox, d);
  await post(devbox, waiting(d, "waiting"));
  sweepStorage(s.deps.db, DEFAULT_LIMITS, Date.now() + 29 * 86_400_000);
  expect((await list("waiting")).items).toHaveLength(1);
  sweepStorage(s.deps.db, DEFAULT_LIMITS, Date.now() + 31 * 86_400_000);
  expect((await list("waiting")).items).toHaveLength(0);
});
