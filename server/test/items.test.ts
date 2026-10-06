import { beforeEach, expect, test } from "bun:test";
import {
  type Answer,
  type Decision,
  open,
  type QuotaSnapshot,
  type SealedItem,
  seal,
} from "@starbridge/protocol";
import {
  type Account,
  type Actor,
  at,
  directory,
  makeServer,
  pair,
  revoke,
  type Server,
  setupAccount,
  signIn,
} from "../test-support/app";

let s: Server;
let acct: Account;
let phone: Actor;
let laptop: Actor;
let devbox: Actor;

beforeEach(async () => {
  s = await makeServer();
  acct = await setupAccount(s);
  phone = acct.device;
  laptop = await pair(s, acct, "laptop", "device", await signIn(s));
  devbox = await pair(s, acct, "devbox", "machine");
});

let n = 0;
function decision(to: Actor[] = [phone, laptop], extra: Partial<Decision> = {}) {
  const body: Decision = {
    v: 1,
    id: `d${++n}`,
    to: to.map((a) => a.id),
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    default: { action: "ship" },
    source: { machine: "devbox", project: "starbridge", session: "s1" },
    ...extra,
  };
  return seal(
    "decision",
    body,
    { id: devbox.id, signKey: devbox.keys.sign.privateKey },
    to.map((a) => a.member),
  );
}

function answer(d: SealedItem, by: Actor = phone) {
  const body: Answer = {
    v: 1,
    id: `a${++n}`,
    decisionId: d.id,
    to: devbox.id,
    answeredAt: at,
    choice: "yes",
  };
  return seal("answer", body, { id: by.id, signKey: by.keys.sign.privateKey }, [devbox.member]);
}

function quota(id: string) {
  const body: QuotaSnapshot = {
    v: 1,
    id,
    to: [phone.id, laptop.id],
    takenAt: at,
    providers: [],
    alerts: [],
  };
  return seal("quota", body, { id: devbox.id, signKey: devbox.keys.sign.privateKey }, [
    phone.member,
    laptop.member,
  ]);
}

const post = (who: Actor, item: unknown) =>
  s.call("POST", "/v1/items", { token: who.token, body: { ...(item as object) } });

test("a machine posts a decision; each device lists it with only its own box and opens it", async () => {
  const d = decision();
  expect((await post(devbox, d)).status).toBe(201);
  const dir = await directory(s, phone.token);
  for (const who of [phone, laptop]) {
    const r = await s.call("GET", "/v1/items?kind=decision", { token: who.token });
    expect(r.json.items).toHaveLength(1);
    const item = r.json.items[0].item as SealedItem & { kind: "decision" };
    expect(item.boxes.map((b: { to: string }) => b.to)).toEqual([who.id]);
    expect(open(item, { id: who.id, box: who.keys.box }, dir).body.question).toBe("Ship it?");
  }
});

test("listing starts at the first item without a cursor and resumes after one", async () => {
  await post(devbox, decision());
  await post(devbox, decision());
  const first = await s.call("GET", "/v1/items", { token: phone.token });
  expect(first.json.items).toHaveLength(2);
  const next = await s.call("GET", `/v1/items?after=${first.json.cursor}`, { token: phone.token });
  expect(next.json).toEqual({ items: [], cursor: first.json.cursor });
  await post(devbox, decision());
  expect(
    (await s.call("GET", `/v1/items?after=${first.json.cursor}`, { token: phone.token })).json
      .items,
  ).toHaveLength(1);
  expect((await s.call("GET", "/v1/items?after=x", { token: phone.token })).status).toBe(400);
});

test("only a machine posts decisions and quotas, only a device answers, each as itself", async () => {
  expect((await post(phone, decision())).status).toBe(403);
  const d = decision();
  await post(devbox, d);
  expect((await post(devbox, answer(d))).status).toBe(403);
  expect((await post(laptop, answer(d, phone))).status).toBe(403); // from names the phone
  expect((await s.call("POST", "/v1/items", { body: decision() })).status).toBe(401);
  expect(
    (await s.call("POST", "/v1/items", { token: await signIn(s), body: answer(d) })).status,
  ).toBe(403);
});

test("boxes must go to active members of the right role", async () => {
  const stranger = { ...phone, id: "stranger", member: { ...phone.member, id: "stranger" } };
  const r = await post(devbox, decision([phone, stranger]));
  expect(r.status).toBe(400);
  expect(r.json.error).toBe("unknown-recipient");
  await revoke(s, acct, "laptop");
  expect((await post(devbox, decision([phone, laptop]))).status).toBe(400);
});

test("a reused item id gets 409, unless its machine re-seals the item while open", async () => {
  const d = decision([phone]);
  expect((await post(devbox, d)).status).toBe(201);
  const [before] = (await s.call("GET", "/v1/items", { token: phone.token })).json.items;
  const r = await post(devbox, quota(d.id));
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("duplicate-id");
  // Only as a re-seal, and only by its machine.
  const again = { ...decision([phone, laptop], { id: d.id }), reseal: true };
  expect((await post(devbox, decision([phone, laptop], { id: d.id }))).status).toBe(409);
  const other = await pair(s, acct, "laptop-m", "machine");
  expect((await post(other, { ...again, from: other.id })).status).toBe(409);
  expect((await post(devbox, { ...decision(), reseal: true })).status).toBe(404);
  // To the laptop, which joined since: one copy each, the arrival kept.
  expect((await post(devbox, again)).status).toBe(201);
  for (const who of [phone, laptop]) {
    const { items } = (await s.call("GET", "/v1/items", { token: who.token })).json;
    expect(items.map((i: { item: SealedItem }) => i.item.id)).toEqual([d.id]);
    expect(items[0].receivedAt).toBe(before.receivedAt);
  }
  await post(laptop, answer(d, laptop));
  expect((await post(devbox, again)).json.error).toBe("already-answered");
});

test("a malformed item gets 400", async () => {
  expect((await post(devbox, { ...decision(), boxes: [] })).status).toBe(400);
  expect((await post(devbox, { ...decision(), re: "d0" })).status).toBe(400);
});

test("an answer marks its decision answered for every device, once", async () => {
  const d = decision();
  await post(devbox, d);
  const before = await s.call("GET", "/v1/items", { token: laptop.token });
  expect(before.json.items[0].answeredAt).toBeUndefined();
  expect((await post(phone, answer(d))).status).toBe(201);
  // The laptop sees the decision again past its cursor, now answered.
  const after = await s.call("GET", `/v1/items?after=${before.json.cursor}`, {
    token: laptop.token,
  });
  expect(after.json.items).toHaveLength(1);
  expect(after.json.items[0].answeredAt).toBeString();
  const again = await post(laptop, answer(d, laptop));
  expect(again.status).toBe(409);
  expect(again.json.error).toBe("already-answered");
});

test("an answer must be to a decision this device was asked, sent to the machine that asked", async () => {
  const onlyPhone = decision([phone]);
  await post(devbox, onlyPhone);
  expect((await post(laptop, answer(onlyPhone, laptop))).status).toBe(404);
  expect((await post(phone, answer({ ...onlyPhone, id: "missing" }))).status).toBe(404);
});

test("the answer long-poll returns at once when answers wait, else completes when one arrives", async () => {
  const d = decision();
  await post(devbox, d);
  const empty = await s.call("GET", "/v1/answers?wait=0.05", { token: devbox.token });
  expect(empty.json.items).toEqual([]);

  const polling = s.call("GET", `/v1/answers?after=${empty.json.cursor}&wait=30`, {
    token: devbox.token,
  });
  await Bun.sleep(20);
  expect(s.deps.answers.count(`${acct.id}/devbox`)).toBe(1);
  const a = answer(d);
  await post(phone, a);
  const r = await polling;
  expect(r.json.items).toHaveLength(1);
  const dir = await directory(s, devbox.token);
  const opened = open(r.json.items[0].item, { id: devbox.id, box: devbox.keys.box }, dir);
  expect(opened.body).toMatchObject({ decisionId: d.id, choice: "yes" });

  const now = await s.call("GET", "/v1/answers?wait=30", { token: devbox.token });
  expect(now.json.items).toHaveLength(1);
  expect(now.json.cursor).toBe(r.json.cursor);
});

test("a machine's answer poll returns when a device joins, and at once when it knows less", async () => {
  const first = await s.call("GET", "/v1/answers", { token: devbox.token });
  const known = first.json.directory as number;
  const polling = s.call("GET", `/v1/answers?wait=30&directory=${known}`, { token: devbox.token });
  await Bun.sleep(20);
  expect(s.deps.answers.count(`${acct.id}/devbox`)).toBe(1);
  await pair(s, acct, "tablet", "device", await signIn(s));
  const r = await polling;
  expect(r.json).toMatchObject({ items: [], directory: known + 1 });

  const stale = await s.call("GET", `/v1/answers?wait=30&directory=${known}`, {
    token: devbox.token,
  });
  expect(stale.json.directory).toBe(known + 1);
});

test("a device's quota ask wakes the machines and waits for their fresh snapshots", async () => {
  await post(devbox, quota("q1"));
  const first = await s.call("GET", "/v1/answers", { token: devbox.token });
  expect(first.json.quotaAsked).toBeUndefined();
  const watch = `/v1/answers?wait=30&directory=${first.json.directory}`;
  const polling = s.call("GET", watch, { token: devbox.token });
  await Bun.sleep(20);

  const asking = s.call("POST", "/v1/quota/ask?wait=30", { token: phone.token });
  const woken = await polling;
  expect(woken.json.quotaAsked).toBeString();
  let done = false;
  asking.then(() => (done = true));
  await Bun.sleep(20);
  expect(done).toBe(false);
  await post(devbox, quota("q2"));
  const asked = await asking;
  expect(asked.json).toEqual({ askedAt: woken.json.quotaAsked, behind: 0 });

  // Once the machine passes the ask it saw, its poll waits again.
  const seen = `${watch}&quotaAsked=${woken.json.quotaAsked}`;
  const started = Date.now();
  await s.call("GET", seen.replace("wait=30", "wait=0.2"), { token: devbox.token });
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  expect((await s.call("POST", "/v1/quota/ask", { token: devbox.token })).status).toBe(403);
});

test("answers are for machines only", async () => {
  expect((await s.call("GET", "/v1/answers", { token: phone.token })).status).toBe(403);
  expect((await s.call("GET", "/v1/items", { token: devbox.token })).status).toBe(403);
});

test("GET /items/:id returns the caller's box only, and 404 to anyone else", async () => {
  const d = decision([phone]);
  await post(devbox, d);
  const r = await s.call("GET", `/v1/items/${d.id}`, { token: phone.token });
  expect(r.json.item.boxes).toEqual([d.boxes[0]]);
  expect((await s.call("GET", `/v1/items/${d.id}`, { token: laptop.token })).status).toBe(404);
  expect((await s.call("GET", `/v1/items/${d.id}`, { token: devbox.token })).status).toBe(404);
});

test("GET /quota returns the latest snapshot of each active machine", async () => {
  await post(devbox, quota("q1"));
  await post(devbox, quota("q2"));
  const r = await s.call("GET", "/v1/quota", { token: phone.token });
  expect(r.json.items.map((x: { item: SealedItem }) => x.item.id)).toEqual(["q2"]);
  await revoke(s, acct, "devbox");
  expect((await s.call("GET", "/v1/quota", { token: phone.token })).json.items).toEqual([]);
});

test("a device revoked while its answer is still uploading cannot answer", async () => {
  const d = decision();
  await post(devbox, d);
  const server = Bun.serve({ port: 0, fetch: (req, srv) => s.app.fetch(req, { server: srv }) });
  try {
    const body = Buffer.from(JSON.stringify(answer(d, laptop)));
    let reply = "";
    const replied = Promise.withResolvers<void>();
    const socket = await Bun.connect({
      hostname: "localhost",
      port: server.port as number,
      socket: {
        data(_, chunk) {
          reply += chunk.toString();
          replied.resolve();
        },
      },
    });
    socket.write(
      `POST /v1/items HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${laptop.token}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
    );
    socket.write(body.subarray(0, 10));
    await Bun.sleep(50);
    // The headers passed authentication; the device is revoked before the body finishes.
    await revoke(s, acct, "laptop");
    socket.write(body.subarray(10));
    await replied.promise;
    socket.end();
    expect(reply).toStartWith("HTTP/1.1 401");
    expect((await post(phone, answer(d))).status).toBe(201);
  } finally {
    server.stop(true);
  }
});
