import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSignUps } from "../src/signups";
import { makeServer, testConfig } from "../test-support/app";

// A stand-in for Apple's keys, token and revoke endpoints.
const apple = generateKeyPairSync("rsa", { modulusLength: 2048 });
const team = generateKeyPairSync("ec", { namedCurve: "P-256" });
const APP_ID = "dev.starbridge.ios";
let server: ReturnType<typeof Bun.serve>;
/** Codes work once, as Apple's do. */
const used = new Set<string>();
let revoked: { client_id: string; token: string }[] = [];

const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** An identity token as Apple signs it; `over` changes its claims. */
function idToken(sub: string, aud = APP_ID, over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ alg: "RS256", kid: "k1" })}.${enc({
    iss: "https://appleid.apple.com",
    aud,
    sub,
    iat: now,
    exp: now + 600,
    ...over,
  })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), apple.privateKey).toString("base64url")}`;
}

/** Whether Apple would take this client secret for `clientId`. */
function secretOk(secret: string, clientId: string): boolean {
  const [h, p, s] = secret.split(".");
  if (!h || !p || !s) return false;
  const ok = verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key: team.publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url"),
  );
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  return ok && claims.iss === "TEAM" && claims.sub === clientId;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/auth/keys")
        return Response.json({
          keys: [{ ...apple.publicKey.export({ format: "jwk" }), kid: "k1" }],
        });
      const form = new URLSearchParams(await req.text());
      const client = form.get("client_id") ?? "";
      if (!secretOk(form.get("client_secret") ?? "", client))
        return Response.json({ error: "invalid_client" }, { status: 400 });
      if (url.pathname === "/auth/token") {
        const code = form.get("code") ?? "";
        // code-<sub>.<n>: each sign-in gets its own.
        const sub = /^code-([^.]+)\./.exec(code)?.[1];
        if (!sub || used.has(code))
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        used.add(code);
        return Response.json({ id_token: idToken(sub, client), refresh_token: `rt-${sub}` });
      }
      if (url.pathname === "/auth/revoke") {
        revoked.push({ client_id: client, token: form.get("token") ?? "" });
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop());
beforeEach(() => {
  revoked = [];
});

function appleConfig() {
  return {
    apple: {
      teamId: "TEAM",
      keyId: "KEY",
      privateKey: team.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      appId: APP_ID,
      url: `http://localhost:${server.port}`,
    },
  };
}

let codes = 0;
/** What AuthenticationServices hands the app for `sub`, with a fresh code. */
function signInBody(sub: string, over: { token?: string; code?: string } = {}) {
  const nonce = "a-nonce-of-the-app-0123456789";
  return {
    identityToken: over.token ?? idToken(sub, APP_ID, { nonce: sha256hex(nonce) }),
    code: over.code ?? `code-${sub}.${codes++}`,
    nonce,
  };
}

test("Sign in with Apple makes one account per Apple user and is listed among the methods", async () => {
  const s = await makeServer(appleConfig());
  expect((await s.call("GET", "/v1/auth/methods")).json.methods).toEqual(["apple", "owner"]);
  const first = await s.call("POST", "/v1/auth/apple/session", { body: signInBody("u1") });
  expect(first.status).toBe(200);
  const again = await s.call("POST", "/v1/auth/apple/session", { body: signInBody("u1") });
  const other = await s.call("POST", "/v1/auth/apple/session", { body: signInBody("u2") });
  const me = async (r: { json: { session: string } }) =>
    (await s.call("GET", "/v1/me", { token: r.json.session })).json.account;
  expect(await me(again)).toBe(await me(first));
  expect(await me(other)).not.toBe(await me(first));
});

test("Apple sign-in refuses a token without the app's nonce, for another app, or replayed", async () => {
  const s = await makeServer(appleConfig());
  const refused = async (body: object) => {
    const r = await s.call("POST", "/v1/auth/apple/session", { body });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("bad-code");
  };
  await refused(signInBody("u3", { token: idToken("u3", APP_ID, { nonce: sha256hex("other") }) }));
  await refused(signInBody("u3", { token: idToken("u3", "com.example.other") }));
  await refused(signInBody("u3", { token: idToken("u3", APP_ID, { exp: 1 }) }));
  // A code of another Apple user, or a code already traded.
  await refused(signInBody("u3", { code: "code-u4.0" }));
  const once = signInBody("u5");
  expect((await s.call("POST", "/v1/auth/apple/session", { body: once })).status).toBe(200);
  await refused(once);
});

test("Apple sign-in is off without the team's key", async () => {
  const s = await makeServer();
  const r = await s.call("POST", "/v1/auth/apple/session", { body: signInBody("u6") });
  expect(r.status).toBe(404);
});

test("deleting an account revokes its Apple token (App Store 5.1.1(v))", async () => {
  const s = await makeServer(appleConfig());
  const { json } = await s.call("POST", "/v1/auth/apple/session", { body: signInBody("u7") });
  expect((await s.call("DELETE", "/v1/account", { token: json.session })).status).toBe(204);
  for (let i = 0; i < 50 && !revoked.length; i++) await Bun.sleep(10);
  expect(revoked).toEqual([{ client_id: APP_ID, token: "rt-u7" }]);
});

test("paused sign-ups refuse a new Apple user and let an existing one in", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "sb-apple-")), "sb.db");
  const s = await makeServer({ ...appleConfig(), dbPath });
  expect((await s.call("POST", "/v1/auth/apple/session", { body: signInBody("u8") })).status).toBe(
    200,
  );
  setSignUps(testConfig({ dbPath }), false);
  expect((await s.call("POST", "/v1/auth/apple/session", { body: signInBody("u8") })).status).toBe(
    200,
  );
  const r = await s.call("POST", "/v1/auth/apple/session", { body: signInBody("u9") });
  expect(r.status).toBe(403);
  expect(r.json.error).toBe("signups-paused");
  setSignUps(testConfig({ dbPath }), true);
});
