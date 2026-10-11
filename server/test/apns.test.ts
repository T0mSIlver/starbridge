import { afterAll, beforeAll, expect, test } from "bun:test";
import http2 from "node:http2";
import { type Decision, type Run, type Snooze, seal } from "@starbridge/protocol";
import { apnsRequest } from "../src/apns";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { checkTarget } from "../src/push";
import { wakeSnoozes } from "../src/snooze";
import { aggregate, dayOf } from "../src/usage";
import {
  type Account,
  type Actor,
  at,
  makeServer,
  pair,
  type Server,
  setupAccount,
  testConfig,
} from "../test-support/app";

interface Sent {
  env: "production" | "sandbox";
  token: string;
  headers: http2.IncomingHttpHeaders;
  body: { aps: Record<string, unknown>; p: Record<string, unknown> };
  jwtValid: boolean;
}

// Device tokens that make the fake APNs answer as Apple does for a dead or foreign token.
const OK = "aa".repeat(32);
const UNREGISTERED = "dd".repeat(32);
const SANDBOX_ONLY = "bb".repeat(32);
const BAD = "cc".repeat(32);
const DOWN = "ee".repeat(32);
const WRONG_TOPIC = "ff".repeat(32);

const sent: Sent[] = [];
let ec: CryptoKeyPair;
let pem: string;
const servers: http2.Http2Server[] = [];
const urls = { production: "", sandbox: "" };

/** A fake APNs over cleartext HTTP/2: Apple's paths, headers and error bodies. */
function fakeApns(env: "production" | "sandbox"): Promise<string> {
  const server = http2.createServer();
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (d: string) => {
      text += d;
    });
    stream.on("end", async () => {
      const token = String(headers[":path"]).replace("/3/device/", "");
      const [h, p, sig] = String(headers.authorization).replace("bearer ", "").split(".");
      const jwtValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        ec.publicKey,
        Buffer.from(sig ?? "", "base64url"),
        Buffer.from(`${h}.${p}`),
      );
      sent.push({ env, token, headers, body: JSON.parse(text), jwtValid });
      const reply = (status: number, reason?: string) => {
        stream.respond({ ":status": status, "apns-id": crypto.randomUUID() });
        stream.end(reason ? JSON.stringify({ reason }) : undefined);
      };
      if (!jwtValid) return reply(403, "InvalidProviderToken");
      if (token === UNREGISTERED) return reply(410, "Unregistered");
      if (token === BAD || (token === SANDBOX_ONLY && env === "production"))
        return reply(400, "BadDeviceToken");
      if (token === DOWN) return reply(503, "ServiceUnavailable");
      if (token === WRONG_TOPIC) return reply(400, "DeviceTokenNotForTopic");
      reply(200);
    });
  });
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    }),
  );
}

beforeAll(async () => {
  ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", ec.privateKey)).toString("base64");
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  urls.production = await fakeApns("production");
  urls.sandbox = await fakeApns("sandbox");
});
afterAll(() => {
  for (const s of servers) s.close();
});

function apnsConfig(): Partial<Config> {
  return {
    apns: {
      keyId: "KEY1234567",
      teamId: "TEAM123456",
      privateKey: pem,
      topic: "dev.starbridge.ios",
      url: urls.production,
      sandboxUrl: urls.sandbox,
    },
  };
}

const servers_: Server[] = [];
afterAll(() => {
  for (const s of servers_) s.deps.push.close();
});

async function setup(over: Partial<Config>) {
  const s = await makeServer(over);
  servers_.push(s);
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  return { s, acct, devbox };
}

async function subscribe(s: Server, acct: Account, endpoint: string, environment?: string) {
  const r = await s.call("POST", "/v1/push/subscriptions", {
    token: acct.device.token,
    body: { type: "apns", endpoint, ...(environment ? { environment } : {}) },
  });
  expect(r.status).toBe(201);
}

async function postDecision(s: Server, acct: Account, devbox: Actor, id: string) {
  const body: Decision = {
    v: 1,
    id,
    to: [acct.device.id],
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    source: { machine: "devbox", project: "p", session: "s" },
  };
  const d = seal("decision", body, { id: devbox.id, signKey: devbox.keys.sign.privateKey }, [
    acct.device.member,
  ]);
  expect((await s.call("POST", "/v1/items", { token: devbox.token, body: d })).status).toBe(201);
  await s.deps.push.idle();
  return d;
}

const endpoints = (s: Server) =>
  (s.deps.db.query("SELECT endpoint FROM push_subscriptions").all() as { endpoint: string }[])
    .map((r) => r.endpoint)
    .sort();

test("a decision goes to APNs as an alert the service extension opens, signed with the team's key", async () => {
  const { s, acct, devbox } = await setup(apnsConfig());
  await subscribe(s, acct, OK);
  sent.length = 0;
  const before = Math.floor(Date.now() / 1000);
  // Two phones at once: both pushes start before any provider token exists.
  await subscribe(s, acct, SANDBOX_ONLY, "sandbox");
  const d = await postDecision(s, acct, devbox, "d1");
  await postDecision(s, acct, devbox, "d2");

  expect(sent.map((x) => [x.env, x.token, x.jwtValid]).sort()).toEqual(
    [
      ["production", OK, true],
      ["production", OK, true],
      ["sandbox", SANDBOX_ONLY, true],
      ["sandbox", SANDBOX_ONLY, true],
    ].sort(),
  );
  // One provider token for all: APNs refuses a new one within 20 minutes.
  expect(new Set(sent.map((x) => x.headers.authorization)).size).toBe(1);
  const first = sent.find((x) => x.token === OK);
  const [h] = String(first?.headers.authorization).replace("bearer ", "").split(".");
  expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({
    alg: "ES256",
    kid: "KEY1234567",
  });
  expect(first?.headers).toMatchObject({
    "apns-topic": "dev.starbridge.ios",
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-collapse-id": "d1",
  });
  expect(Number(first?.headers["apns-expiration"]) - before).toBeGreaterThanOrEqual(86_400);
  expect(first?.body).toEqual({
    aps: {
      alert: { title: "Starbridge", body: "A question needs you" },
      sound: "default",
      "mutable-content": 1,
      category: "decision",
      "thread-id": "devbox",
    },
    p: { v: 1, kind: "decision", id: "d1", from: "devbox", box: d.boxes[0]?.box },
  });
  expect(aggregate(s.deps.db, dayOf(Date.now()))).toMatchObject({ "push.apns.ok": 4 });
});

test("runs skip APNs, as they skip Web Push: the app fetches them", async () => {
  const { s, acct, devbox } = await setup(apnsConfig());
  await subscribe(s, acct, OK);
  sent.length = 0;
  const run: Run = {
    v: 1,
    id: "r1",
    to: [acct.device.id],
    title: "Mac e2e",
    reason: "uses your session and keyboard",
    source: { machine: devbox.id, project: "starbridge", session: "s1" },
    startedAt: at,
    at,
  };
  const r = seal("run", run, { id: devbox.id, signKey: devbox.keys.sign.privateKey }, [
    acct.device.member,
  ]);
  expect((await s.call("POST", "/v1/items", { token: devbox.token, body: r })).status).toBe(201);
  await s.deps.push.idle();
  expect(sent).toEqual([]);
});

test("closing and hiding go as background pushes; a waiting flip and a snooze's return replace the question", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const req = (head: object) => apnsRequest(JSON.stringify({ v: 1, ...head }), "t", now);
  for (const head of [
    { kind: "answered", id: "d1" },
    { kind: "settled", id: "s1", from: "devbox", re: "d1" },
    { kind: "snooze", id: "z1", from: "phone", re: "d1", wakeAt: "2026-10-10T18:00:00Z" },
    { kind: "quota", id: "q1", from: "devbox" },
  ]) {
    const r = req(head);
    expect(r.headers).toMatchObject({ "apns-push-type": "background", "apns-priority": "5" });
    expect(r.headers["apns-collapse-id"]).toBeUndefined();
    expect(JSON.parse(r.body).aps).toEqual({ "content-available": 1 });
  }
  const back = req({
    kind: "snooze",
    id: "z1",
    from: "phone",
    re: "d1",
    wakeAt: "2026-10-10T11:59:00Z",
  });
  expect(back.headers).toMatchObject({ "apns-push-type": "alert", "apns-collapse-id": "d1" });
  const waiting = req({ kind: "waiting", id: "w1", from: "devbox", re: "d1" });
  expect(waiting.headers["apns-collapse-id"]).toBe("d1");
  expect(JSON.parse(waiting.body).aps.category).toBe("decision");
  const permission = JSON.parse(req({ kind: "permission", id: "p1", from: "devbox" }).body).aps;
  expect(permission).toMatchObject({ category: "permission", "thread-id": "devbox" });
  const join = JSON.parse(req({ kind: "join", id: "j1" }).body).aps;
  expect(join).toMatchObject({ category: "join", "thread-id": "join" });
  // Over APNs' 4 KB, the box stays behind and the device fetches the item.
  const big = req({ kind: "decision", id: "d1", from: "devbox", box: "x".repeat(4000) });
  expect(JSON.parse(big.body).p).toEqual({ v: 1, kind: "decision", id: "d1", from: "devbox" });
});

test("only a token APNs calls dead in both environments drops its subscription (#1011)", async () => {
  const { s, acct, devbox } = await setup(apnsConfig());
  for (const t of [OK, UNREGISTERED, BAD, DOWN, WRONG_TOPIC]) await subscribe(s, acct, t);
  // A debug build's token, sent as production by mistake: delivered through the sandbox.
  await subscribe(s, acct, SANDBOX_ONLY);
  sent.length = 0;
  await postDecision(s, acct, devbox, "d1");
  expect(sent.filter((x) => x.token === SANDBOX_ONLY).map((x) => x.env)).toEqual([
    "production",
    "sandbox",
  ]);
  expect(sent.filter((x) => x.token === BAD).map((x) => x.env)).toEqual(["production", "sandbox"]);
  // An outage or the server's own wrong topic keeps the subscription.
  expect(endpoints(s)).toEqual([OK, SANDBOX_ONLY, DOWN, WRONG_TOPIC].sort());
});

test("a sandbox subscription goes to the sandbox; subscribing again takes the new environment", async () => {
  const { s, acct, devbox } = await setup(apnsConfig());
  await subscribe(s, acct, OK, "sandbox");
  sent.length = 0;
  await postDecision(s, acct, devbox, "d1");
  expect(sent.map((x) => x.env)).toEqual(["sandbox"]);
  await subscribe(s, acct, OK);
  sent.length = 0;
  await postDecision(s, acct, devbox, "d2");
  expect(sent.map((x) => x.env)).toEqual(["production"]);
});

test("an APNs subscription needs a hex token; environment is for APNs only", async () => {
  const t = (endpoint: string, environment?: "production" | "sandbox", type = "apns" as const) =>
    checkTarget({ type, endpoint, environment }, []);
  expect(t(OK)).toBeUndefined();
  expect(t(OK, "sandbox")).toBeUndefined();
  for (const bad of ["xyz", "ab".repeat(8), `${OK}0`, "https://push.example/x"])
    expect(t(bad)).toBe("not an APNs token");
  expect(checkTarget({ type: "fcm", endpoint: "tok", environment: "sandbox" }, [])).toBe(
    "environment is for apns only",
  );
  const { s, acct } = await setup({});
  const r = await s.call("POST", "/v1/push/subscriptions", {
    token: acct.device.token,
    body: { type: "apns", endpoint: OK, environment: "staging" },
  });
  expect(r.status).toBe(400);
});

test("relay mode: a server without an APNs key forwards through the relay, environment included", async () => {
  const relay = await createApp(
    testConfig({ ...apnsConfig(), relayMode: true, ownerToken: undefined }),
  );
  const relayServer = Bun.serve({
    port: 0,
    fetch: (req, server) => relay.app.fetch(req, { server }),
  });
  try {
    const { s, acct, devbox } = await setup({ relayUrl: `http://localhost:${relayServer.port}` });
    await subscribe(s, acct, OK, "sandbox");
    await subscribe(s, acct, UNREGISTERED);
    sent.length = 0;
    await postDecision(s, acct, devbox, "d1");
    expect(sent.map((x) => [x.env, x.token]).sort()).toEqual(
      [
        ["production", UNREGISTERED],
        ["sandbox", OK],
      ].sort(),
    );
    // The relay's "gone" drops the sender's subscription.
    expect(endpoints(s)).toEqual([OK]);
    expect(aggregate(relay.deps.db, dayOf(Date.now()))).toMatchObject({
      "relay.apns.ok": 1,
      "relay.apns.gone": 1,
    });
  } finally {
    relay.deps.push.close();
    relayServer.stop(true);
  }
});

test("a snooze's return is grouped under its question's machine, through the relay too (#1168)", async () => {
  const relay = await createApp(
    testConfig({ ...apnsConfig(), relayMode: true, ownerToken: undefined }),
  );
  const relayServer = Bun.serve({
    port: 0,
    fetch: (req, server) => relay.app.fetch(req, { server }),
  });
  try {
    for (const over of [apnsConfig(), { relayUrl: `http://localhost:${relayServer.port}` }]) {
      const { s, acct, devbox } = await setup(over);
      await subscribe(s, acct, OK);
      const d = await postDecision(s, acct, devbox, "d1");
      const phone = acct.device;
      const body: Snooze = {
        v: 1,
        id: "z1",
        decisionId: d.id,
        to: [devbox.id, phone.id],
        // APNs hides a snooze until its time by the clock, so it returns within the test.
        until: new Date(Date.now() + 1_000).toISOString(),
        at: new Date().toISOString(),
      };
      const z = seal("snooze", body, { id: phone.id, signKey: phone.keys.sign.privateKey }, [
        devbox.member,
        phone.member,
      ]);
      expect((await s.call("POST", "/v1/items", { token: phone.token, body: z })).status).toBe(201);
      await s.deps.push.idle();
      sent.length = 0;
      await Bun.sleep(1_100);
      wakeSnoozes(s.deps.db, s.deps.push, 3072);
      await s.deps.push.idle();
      expect(sent.map((x) => [x.body.p.kind, x.body.p.from, x.body.aps["thread-id"]])).toEqual([
        ["snooze", phone.id, devbox.id],
      ]);
    }
  } finally {
    relay.deps.push.close();
    relayServer.stop(true);
  }
});
