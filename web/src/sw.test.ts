// The service worker's push handler, run against a stub worker scope, a fake IndexedDB and the
// real server, with this browser a device of the owner's account.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  addEntry,
  generateMemberKeys,
  type MemberKeys,
  publicKeys,
  ready,
  type SealedItem,
  seal,
} from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { api } from "./lib/api";
import * as device from "./lib/device";
import * as store from "./lib/store";

type Note = { title: string; tag: string; close(): void };
type Listener = (e: { data?: { text(): string }; waitUntil(p: Promise<unknown>): void }) => void;
const listeners = new Map<string, Listener>();
/** The notifications up, as the browser keeps them: one per tag. */
let notes: Note[] = [];
/** How many times the worker showed a notification. */
let shows = 0;
const errors: string[] = [];
/** This browser's push service: Chrome's unless a test sets Safari's. */
let endpoint = "https://fcm.googleapis.com/fcm/send/x";
function note(title: string, tag: string): Note {
  const n: Note = {
    title,
    tag,
    close: () => {
      notes = notes.filter((x) => x !== n);
    },
  };
  return n;
}
Object.assign(globalThis, {
  self: {
    addEventListener: (type: string, f: Listener) => listeners.set(type, f),
    registration: {
      showNotification: async (title: string, o: { tag?: string } = {}) => {
        shows++;
        notes = [...notes.filter((n) => n.tag !== o.tag), note(title, o.tag ?? "")];
      },
      getNotifications: async (o: { tag?: string } = {}) =>
        notes.filter((n) => o.tag === undefined || n.tag === o.tag),
      pushManager: { getSubscription: async () => ({ endpoint }) },
    },
    // The open page, which the worker tells why a push showed nothing.
    clients: {
      matchAll: async () => [
        {
          postMessage: (m: { type: string; error?: string }) =>
            m.error !== undefined && errors.push(m.error),
        },
      ],
    },
  },
});
// A variable path, so the page's typecheck leaves the worker's own lib alone.
const worker = "./sw/sw.ts";
await import(worker);

let live: LiveServer;
let ctx: device.Ctx;
const realFetch = globalThis.fetch;
const realGenerateKey = crypto.subtle.generateKey;
let mKeys: MemberKeys;
const machine = () => ({
  id: "m_devbox",
  role: "machine" as const,
  name: "devbox",
  ...publicKeys(mKeys),
});

beforeAll(async () => {
  await ready;
  mKeys = generateMemberKeys();
  live = await LiveServer.start();
  // The page's and the worker's same-origin calls, with the session cookie a browser keeps.
  let cookie = "";
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const res = await realFetch(`${live.url}${input}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), cookie },
    });
    cookie = res.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return res;
  }) as typeof fetch;
  device.retryDelay.ms = 10;
  // Bun cannot store a CryptoKey in IndexedDB, so the keys take the raw libsodium fallback.
  crypto.subtle.generateKey = (() =>
    Promise.reject(new Error("no WebCrypto keys"))) as typeof crypto.subtle.generateKey;
  await api.ownerSignIn("owner-secret");
  const { account } = await api.me();
  // What boot() records for the page.
  await store.put("current", account);
  const join = await device.startJoin(account, "This browser");
  await live.approve(join.code);
  await join.done;
  const phone = { id: "phone", signKey: live.owner.device.keys.sign.privateKey };
  const r = await realFetch(`${live.url}/v1/directory`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${live.owner.device.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      entry: addEntry(await live.directory(), phone, machine(), "2026-10-11T12:00:00Z"),
    }),
  });
  expect(r.status).toBe(201);
  ctx = (await device.deviceContext(account)) as device.Ctx;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  crypto.subtle.generateKey = realGenerateKey;
  live.stop();
});

async function push(payload: object): Promise<void> {
  const onPush = listeners.get("push");
  if (!onPush) throw new Error("the worker listens for no push");
  let done: Promise<unknown> = Promise.resolve();
  onPush({
    data: { text: () => JSON.stringify(payload) },
    waitUntil: (p) => {
      done = p;
    },
  });
  await done;
}

/** A sealed item's push to this browser, its box inline. */
const payload = (item: SealedItem, extra: object = {}) => ({
  ...extra,
  v: 1,
  kind: item.kind,
  id: item.id,
  from: item.from,
  ...(item.re ? { re: item.re } : {}),
  box: item.boxes.find((b) => b.to === ctx.device.id)?.box,
});

/** Seals a body from the machine to this browser. */
function fromMachine(kind: "decision" | "waiting", body: object, re?: string): SealedItem {
  const { id, boxPk } = ctx.device;
  const item = seal(
    kind,
    { v: 1, to: [id], ...body } as never,
    { id: "m_devbox", signKey: mKeys.sign.privateKey },
    [{ id, boxPk }],
  );
  return re ? { ...item, re } : item;
}

function decision(id: string, extra: object = {}): SealedItem {
  return fromMachine("decision", {
    id,
    createdAt: "2026-10-11T12:00:00Z",
    question: `Question ${id}`,
    context: "",
    options: ["Yes", "No"],
    recommended: "Yes",
    source: { machine: "devbox", project: "p", session: "s" },
    ...extra,
  });
}

test("a join request shows only on a device of the account the browser is signed in to", async () => {
  try {
    // Signed out: no current account.
    await store.del("current");
    await push({ v: 1, kind: "join", id: "j1" });
    // Signed in to an account this browser is not a device of, as after a sign-out and a sign-in
    // to another account while the server still holds the endpoint under the first one (#1230).
    await store.put("current", "acct_other");
    await push({ v: 1, kind: "join", id: "j2" });
    expect(notes).toEqual([]);
  } finally {
    await store.put("current", ctx.account);
  }
});

test("a late waiting push signed before the question's snooze shows nothing (#1280)", async () => {
  notes = [];
  const d = decision("d_snoozed");
  live.inject(d);
  // The latest snooze this browser knows of, as noteSnoozes keeps it.
  await store.put("snoozes", { d_snoozed: "2026-10-11T12:10:00Z" }, ctx.account);
  const waiting = (id: string, at: string) =>
    fromMachine("waiting", { id, decisionId: "d_snoozed", at, state: "waiting" }, "d_snoozed");
  await push(payload(waiting("w_before", "2026-10-11T12:05:00Z")));
  expect(notes).toEqual([]);
  // A flip after the snooze, which the server pushes once it is over, notifies.
  await push(payload(waiting("w_after", "2026-10-11T12:20:00Z")));
  expect(notes.map((n) => n.title)).toEqual(["Question d_snoozed"]);
});

test("a withheld push closes the question and prompt notifications only (#1281), and shows the placeholder (#1363)", async () => {
  notes = ["d:a", "p:b", "r:c", "q:claude/5h/low", "j:e"].map((tag) => note(tag, tag));
  const dir = await live.directory();
  // A head past the directory the server serves: it holds an entry back (#362).
  await push(
    payload(decision("d_held", { dir: { length: dir.length + 1, head: "A".repeat(43) } })),
  );
  expect(errors.at(-1)).toContain("holding back changes to your devices");
  // The question still needs the owner, so its placeholder shows, which has no buttons.
  expect(notes.map((n) => [n.tag, n.title])).toEqual([
    ["r:c", "r:c"],
    ["q:claude/5h/low", "q:claude/5h/low"],
    ["j:e", "j:e"],
    ["d:d_held", "Starbridge"],
  ]);
  // The head it kept would hold back every later push.
  await store.del("heads", ctx.account);
});

test("a snooze's first push that comes late never notifies; its return does (#1290)", async () => {
  const d = decision("d_late");
  live.inject(d);
  notes = [];
  const before = shows;
  // Five minutes from posting, its first push four minutes late: within the clock's 2-minute skew.
  const now = Date.now();
  const { id, boxPk } = ctx.device;
  const z = seal(
    "snooze",
    {
      v: 1,
      id: "z_late",
      decisionId: "d_late",
      to: ["m_devbox", id],
      until: new Date(now + 60_000).toISOString(),
      at: new Date(now - 4 * 60_000).toISOString(),
    },
    { id: "phone", signKey: live.owner.device.keys.sign.privateKey },
    [
      { id: "m_devbox", boxPk: publicKeys(mKeys).boxPk },
      { id, boxPk },
    ],
  );
  const item = { ...z, re: "d_late", wakeAt: new Date(now + 60_000).toISOString() };
  await push(payload(item, { wakeAt: item.wakeAt, due: false }));
  expect(shows).toBe(before);
  await push(payload(item, { wakeAt: item.wakeAt, due: true }));
  expect(shows).toBe(before + 1);
  expect(notes.map((n) => n.tag)).toEqual(["d:d_late"]);
});

test("a snooze's first push that comes after its return leaves the question up, by a clock behind too (#1290)", async () => {
  const d = decision("d_order");
  live.inject(d);
  // Its return already showed the question; push services keep no order.
  notes = [note("Question d_order", "d:d_order")];
  const now = Date.now();
  const { id, boxPk } = ctx.device;
  // Its time a minute ahead: the server's clock may run ahead of this browser's.
  const until = new Date(now + 60_000).toISOString();
  const z = seal(
    "snooze",
    {
      v: 1,
      id: "z_order",
      decisionId: "d_order",
      to: ["m_devbox", id],
      until,
      at: new Date(now - 6 * 60_000).toISOString(),
    },
    { id: "phone", signKey: live.owner.device.keys.sign.privateKey },
    [
      { id: "m_devbox", boxPk: publicKeys(mKeys).boxPk },
      { id, boxPk },
    ],
  );
  await push(payload({ ...z, re: "d_order", wakeAt: until }, { wakeAt: until, due: false }));
  expect(notes.map((n) => n.tag)).toEqual(["d:d_order"]);
});

test("a question whose item cannot be read shows the placeholder, which tapped opens the inbox (#1363)", async () => {
  notes = [];
  // Too big to carry its box, and gone from the server: the fetch fails.
  await push({ v: 1, kind: "decision", id: "d_unread", from: "m_devbox" });
  expect(notes.map((n) => [n.tag, n.title])).toEqual([["d:d_unread", "Starbridge"]]);
  // Its own notification, once it opens, takes the placeholder's place.
  await push(payload(decision("d_unread")));
  expect(notes.map((n) => [n.tag, n.title])).toEqual([["d:d_unread", "Question d_unread"]]);
});

test("on Safari, a push with nothing to show still shows a quiet notification (#1363)", async () => {
  notes = [];
  try {
    await push({ v: 1, kind: "answered", id: "d_other" });
    expect(notes).toEqual([]);
    // Safari drops the subscription after three pushes that show nothing.
    endpoint = "https://web.push.apple.com/QGx";
    await push({ v: 1, kind: "answered", id: "d_other" });
    expect(notes.map((n) => [n.tag, n.title])).toEqual([["quiet", "Starbridge"]]);
  } finally {
    endpoint = "https://fcm.googleapis.com/fcm/send/x";
  }
});
