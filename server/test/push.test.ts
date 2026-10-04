import { afterAll, beforeAll, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { type Decision, seal } from "@starbridge/protocol";
import * as ece from "http_ece";
import webpush from "web-push";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { checkTarget } from "../src/push";
import {
  type Account,
  type Actor,
  at,
  makeServer,
  pair,
  type Server,
  setupAccount,
  testConfig,
} from "./helpers";

interface Seen {
  path: string;
  headers: Headers;
  body: Buffer;
}

// Stands in for Google's token endpoint, FCM, and browser push services.
let fake: ReturnType<typeof Bun.serve>;
const seen: Seen[] = [];
let rsa: CryptoKeyPair;
let pem: string;
const vapid = webpush.generateVAPIDKeys();
const base = () => `http://localhost:${fake.port}`;

beforeAll(async () => {
  rsa = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", rsa.privateKey)).toString(
    "base64",
  );
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = Buffer.from(await req.arrayBuffer());
      seen.push({ path: url.pathname, headers: req.headers, body });
      if (url.pathname === "/token") {
        const assertion = new URLSearchParams(body.toString()).get("assertion") ?? "";
        const [h, p, sig] = assertion.split(".");
        const ok = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          rsa.publicKey,
          Buffer.from(sig ?? "", "base64url"),
          Buffer.from(`${h}.${p}`),
        );
        return ok
          ? Response.json({ access_token: "google-token", expires_in: 3600 })
          : new Response("bad assertion", { status: 400 });
      }
      if (url.pathname.endsWith("/messages:send")) {
        if (req.headers.get("authorization") !== "Bearer google-token")
          return new Response("", { status: 401 });
        const token = JSON.parse(body.toString()).message.token as string;
        if (token === "gone-token")
          return Response.json(
            { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
            { status: 404 },
          );
        return Response.json({ name: "projects/p/messages/1" });
      }
      if (url.pathname === "/wp/gone") return new Response("", { status: 410 });
      if (url.pathname.startsWith("/wp/")) return new Response("", { status: 201 });
      return new Response("", { status: 404 });
    },
  });
});
afterAll(() => fake.stop());

function fcmConfig(): Partial<Config> {
  return {
    fcm: {
      projectId: "p",
      clientEmail: "sa@p.iam",
      privateKey: pem,
      tokenUrl: `${base()}/token`,
      apiUrl: base(),
    },
  };
}

function vapidConfig(): Partial<Config> {
  return { vapid: { ...vapid, subject: "mailto:owner@example.com" } };
}

/** A browser's push subscription: its keys, and how to decrypt what reaches it. */
function browserSubscription(path: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16).toString("base64url");
  return {
    target: {
      type: "webpush" as const,
      endpoint: `${base()}/wp/${path}`,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth },
    },
    decrypt: (body: Buffer) =>
      ece.decrypt(body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth }).toString(),
  };
}

async function setup(over: Partial<Config>) {
  const s = await makeServer(over);
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  return { s, acct, devbox };
}

function decision(devbox: Actor, phone: Actor, id: string, context = "") {
  const body: Decision = {
    v: 1,
    id,
    to: [phone.id],
    createdAt: at,
    question: "Ship it?",
    context,
    options: ["yes", "no"],
    recommended: "yes",
    default: { action: "ship" },
    source: { machine: "devbox", project: "p", session: "s" },
  };
  return seal("decision", body, { id: devbox.id, signKey: devbox.keys.sign.privateKey }, [
    phone.member,
  ]);
}

async function postDecision(s: Server, acct: Account, devbox: Actor, id: string, context = "") {
  const d = decision(devbox, acct.device, id, context);
  const r = await s.call("POST", "/v1/items", { token: devbox.token, body: d });
  expect(r.status).toBe(201);
  await s.deps.push.idle();
  return d;
}

const fcmSends = () =>
  seen
    .filter((x) => x.path.endsWith("/messages:send"))
    .map((x) => JSON.parse(x.body.toString()).message);

test("subscriptions: add, re-add keeps the id, delete; only for a paired device", async () => {
  const { s, acct, devbox } = await setup({});
  const sub = { type: "fcm", endpoint: "tok-1" };
  const a = await s.call("POST", "/v1/push/subscriptions", { token: acct.device.token, body: sub });
  expect(a.status).toBe(201);
  const b = await s.call("POST", "/v1/push/subscriptions", { token: acct.device.token, body: sub });
  expect(b.json.id).toBe(a.json.id);
  expect(
    (await s.call("POST", "/v1/push/subscriptions", { token: devbox.token, body: sub })).status,
  ).toBe(403);
  expect((await s.call("POST", "/v1/push/subscriptions", { body: sub })).status).toBe(401);
  expect(
    (await s.call("DELETE", `/v1/push/subscriptions/${a.json.id}`, { token: devbox.token })).status,
  ).toBe(403);
  expect(
    (await s.call("DELETE", `/v1/push/subscriptions/${a.json.id}`, { token: acct.device.token }))
      .status,
  ).toBe(204);
  expect(
    (await s.call("DELETE", `/v1/push/subscriptions/${a.json.id}`, { token: acct.device.token }))
      .status,
  ).toBe(404);
});

test("subscriptions to private or plain-HTTP addresses are refused unless allowed", () => {
  const wp = (endpoint: string) => ({
    type: "webpush" as const,
    endpoint,
    keys: { p256dh: "x", auth: "y" },
  });
  for (const e of [
    "http://push.example/x",
    "https://localhost/x",
    "https://localhost./x",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://192.168.1.10/x",
    "https://169.254.169.254/x",
    "https://[::1]/x",
    "https://[::ffff:10.0.0.1]/x",
    "https://box.internal/x",
  ])
    expect(checkTarget(wp(e), false)).toBeString();
  expect(checkTarget(wp("https://fcm.googleapis.com/fcm/send/abc"), false)).toBeUndefined();
  expect(checkTarget(wp("http://10.0.0.5:8080/up"), true)).toBeUndefined();
  expect(checkTarget({ type: "webpush", endpoint: "https://push.example/x" }, false)).toBe(
    "webpush needs keys",
  );
  expect(checkTarget({ type: "fcm", endpoint: "abc:DEF_1-2" }, false)).toBeUndefined();
});

test("FCM direct: a decision pushes the device's own box; a gone token drops its subscription", async () => {
  const { s, acct, devbox } = await setup(fcmConfig());
  for (const endpoint of ["tok-ok", "gone-token"])
    await s.call("POST", "/v1/push/subscriptions", {
      token: acct.device.token,
      body: { type: "fcm", endpoint },
    });
  seen.length = 0;
  const d = await postDecision(s, acct, devbox, "d1");

  const sent = fcmSends();
  expect(sent.map((m) => m.token).sort()).toEqual(["gone-token", "tok-ok"]);
  const payload = JSON.parse(sent[0].data.p);
  expect(payload).toEqual({
    v: 1,
    kind: "decision",
    id: "d1",
    from: "devbox",
    box: d.boxes[0]?.box,
  });
  expect(sent[0].android.priority).toBe("HIGH");
  const left = s.deps.db.query("SELECT endpoint FROM push_subscriptions").all();
  expect(left).toEqual([{ endpoint: "tok-ok" }]);
});

test("a push carries only the item id when the box would not fit", async () => {
  const { s, acct, devbox } = await setup(fcmConfig());
  await s.call("POST", "/v1/push/subscriptions", {
    token: acct.device.token,
    body: { type: "fcm", endpoint: "tok-ok" },
  });
  seen.length = 0;
  await postDecision(s, acct, devbox, "big", "x".repeat(4000));
  expect(JSON.parse(fcmSends()[0].data.p)).toEqual({
    v: 1,
    kind: "decision",
    id: "big",
    from: "devbox",
  });
});

test("an answer pushes 'answered' to the decision's devices so they clear it", async () => {
  const { s, acct, devbox } = await setup(fcmConfig());
  await s.call("POST", "/v1/push/subscriptions", {
    token: acct.device.token,
    body: { type: "fcm", endpoint: "tok-ok" },
  });
  const d = await postDecision(s, acct, devbox, "d1");
  seen.length = 0;
  const a = seal(
    "answer",
    { v: 1, id: "a1", decisionId: d.id, to: "devbox", answeredAt: at, choice: "yes" },
    { id: acct.device.id, signKey: acct.device.keys.sign.privateKey },
    [devbox.member],
  );
  expect((await s.call("POST", "/v1/items", { token: acct.device.token, body: a })).status).toBe(
    201,
  );
  await s.deps.push.idle();
  expect(JSON.parse(fcmSends()[0].data.p)).toEqual({ v: 1, kind: "answered", id: "d1" });
});

test("Web Push direct: the browser decrypts the payload; VAPID signs the request", async () => {
  const { s, acct, devbox } = await setup(vapidConfig());
  const browser = browserSubscription("ok");
  await s.call("POST", "/v1/push/subscriptions", {
    token: acct.device.token,
    body: browser.target,
  });
  seen.length = 0;
  const d = await postDecision(s, acct, devbox, "d1");
  const req = seen.find((x) => x.path === "/wp/ok");
  expect(req?.headers.get("authorization")).toStartWith(`vapid t=`);
  expect(req?.headers.get("authorization")).toContain(`k=${vapid.publicKey}`);
  expect(JSON.parse(browser.decrypt(req?.body as Buffer)).box).toBe(d.boxes[0]?.box);
  expect((await s.call("GET", "/v1/push/vapid")).json).toEqual({ publicKey: vapid.publicKey });
});

test("UnifiedPush goes straight to the distributor, encrypted when it has keys", async () => {
  const { s, acct, devbox } = await setup({});
  const up = browserSubscription("up");
  await s.call("POST", "/v1/push/subscriptions", {
    token: acct.device.token,
    body: { ...up.target, type: "unifiedpush" },
  });
  seen.length = 0;
  await postDecision(s, acct, devbox, "d1");
  const req = seen.find((x) => x.path === "/wp/up");
  expect(req?.headers.get("authorization")).toBeNull();
  expect(JSON.parse(up.decrypt(req?.body as Buffer)).id).toBe("d1");
});

test("relay mode: a server without credentials forwards FCM and Web Push through the relay", async () => {
  const relay = await createApp(
    testConfig({ ...fcmConfig(), ...vapidConfig(), relayMode: true, ownerToken: undefined }),
  );
  const relayServer = Bun.serve({
    port: 0,
    fetch: (req, server) => relay.app.fetch(req, { server }),
  });
  try {
    const { s, acct, devbox } = await setup({ relayUrl: `http://localhost:${relayServer.port}` });
    const browser = browserSubscription("relayed");
    await s.call("POST", "/v1/push/subscriptions", {
      token: acct.device.token,
      body: { type: "fcm", endpoint: "tok-ok" },
    });
    await s.call("POST", "/v1/push/subscriptions", {
      token: acct.device.token,
      body: browser.target,
    });
    // The web page subscribes with the relay's VAPID key.
    expect((await s.call("GET", "/v1/push/vapid")).json).toEqual({ publicKey: vapid.publicKey });
    seen.length = 0;
    const d = await postDecision(s, acct, devbox, "d1");
    expect(JSON.parse(fcmSends()[0].data.p).box).toBe(d.boxes[0]?.box);
    const req = seen.find((x) => x.path === "/wp/relayed");
    expect(JSON.parse(browser.decrypt(req?.body as Buffer)).id).toBe("d1");
  } finally {
    relayServer.stop(true);
  }
});

test("the relay route is off unless RELAY_MODE, refuses UnifiedPush and private endpoints", async () => {
  const off = await makeServer(fcmConfig());
  const msg = { type: "fcm", endpoint: "tok-ok", payload: "{}" };
  expect((await off.call("POST", "/v1/relay", { body: msg })).status).toBe(404);
  const on = await makeServer({
    ...fcmConfig(),
    relayMode: true,
    allowPrivatePushEndpoints: false,
  });
  expect((await on.call("POST", "/v1/relay", { body: msg })).json).toEqual({ result: "ok" });
  expect(
    (
      await on.call("POST", "/v1/relay", {
        body: { ...msg, type: "unifiedpush", endpoint: "https://up.example/x" },
      })
    ).status,
  ).toBe(400);
  const priv = {
    type: "webpush",
    endpoint: "http://10.0.0.1/x",
    keys: { p256dh: "a", auth: "b" },
    payload: "{}",
  };
  expect((await on.call("POST", "/v1/relay", { body: priv })).status).toBe(400);
  expect(
    (await on.call("POST", "/v1/relay", { body: { ...msg, payload: "x".repeat(5000) } })).status,
  ).toBe(400);
});

test("a relay without credentials of its own does not forward onward", async () => {
  const on = await makeServer({ relayMode: true, relayUrl: "http://localhost:1" });
  const r = await on.call("POST", "/v1/relay", {
    body: { type: "fcm", endpoint: "tok-ok", payload: "{}" },
  });
  expect(r.json).toEqual({ result: "no-route" });
});

test("a push host that resolves to a private address is not called", async () => {
  const { openDb } = await import("../src/db");
  const { Push } = await import("../src/push");
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return new Response("", { status: 201 });
  }) as unknown as typeof fetch;
  const dns: Record<string, string[]> = {
    "push.example": ["93.184.216.34"],
    "rebound.example": ["93.184.216.34", "10.0.0.7"],
  };
  const push = new Push(
    testConfig({ allowPrivatePushEndpoints: false }),
    openDb(":memory:"),
    fetchFn,
    async (host) => dns[host] ?? [],
  );
  const target = (host: string) => ({
    type: "unifiedpush" as const,
    endpoint: `https://${host}/up`,
  });
  expect(await push.send(target("rebound.example"), "{}")).toBe("failed");
  expect(await push.send(target("localhost."), "{}")).toBe("failed");
  expect(calls).toEqual([]);
  expect(await push.send(target("push.example"), "{}")).toBe("ok");
  expect(calls).toEqual(["https://push.example/up"]);
});
