import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Apple, AppleRefused } from "../src/apple";
import { setSignUps } from "../src/signups";
import { DEFAULT_LIMITS, makeServer, testConfig } from "../test-support/app";

// A stand-in for Apple's keys, token and revoke endpoints.
const apple = generateKeyPairSync("rsa", { modulusLength: 2048 });
const team = generateKeyPairSync("ec", { namedCurve: "P-256" });
const APP_ID = "dev.starbridge.ios";
const WEB_ID = "dev.starbridge.web";
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
        // code-<sub>.<n>, each sign-in its own, and .<nonce> when the authorize request had one.
        const [, sub, nonce] = /^code-([^.]+)\.\d+(?:\.(.+))?$/.exec(code) ?? [];
        if (!sub || used.has(code))
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        used.add(code);
        return Response.json({
          id_token: idToken(sub, client, nonce ? { nonce } : {}),
          refresh_token: `rt-${sub}`,
        });
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
      servicesId: WEB_ID,
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
  const native = await makeServer({ apple: { ...appleConfig().apple, servicesId: undefined } });
  expect((await native.call("GET", "/v1/auth/methods")).json.methods).toEqual(["owner"]);
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
  // A shutdown waits for it, as for queued pushes.
  await s.deps.apple?.idle();
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

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

test("the page signs in with Apple's web flow: no scope, state in a cookie, the Services ID's code", async () => {
  const s = await makeServer(appleConfig());
  const start = await s.app.request("/v1/auth/apple");
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.pathname).toBe("/auth/authorize");
  expect(authorize.searchParams.get("client_id")).toBe(WEB_ID);
  expect(authorize.searchParams.has("scope")).toBe(false);
  expect(authorize.searchParams.get("response_mode")).toBe("query");
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const state = authorize.searchParams.get("state");
  const back = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  expect(back.pathname).toBe("/v1/auth/apple/callback");
  const code = `code-w1.${codes++}`;
  const stranger = await s.app.request(`${back.pathname}?code=${code}&state=${state}`);
  expect(stranger.headers.get("location")).toBe("/?signin=expired");
  const res = await s.app.request(`${back.pathname}?code=${code}&state=${state}`, {
    headers: { cookie },
  });
  expect(res.headers.get("location")).toBe("/");
  expect(res.headers.get("set-cookie")).toContain("sb_session=sbs_");
  const cancelled = await s.app.request(
    `${back.pathname}?error=user_cancelled_authorize&state=${state}`,
    {
      headers: { cookie },
    },
  );
  expect(cancelled.headers.get("location")).toBe("/?signin=declined");
});

test("an app's Apple sign-in binds the code to its challenge through Apple's nonce", async () => {
  const s = await makeServer(appleConfig());
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = s256(verifier);
  const start = await s.app.request(`/v1/auth/apple?app=1&challenge=${challenge}`);
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.searchParams.get("state")).toBe(challenge);
  expect(authorize.searchParams.get("nonce")).toBe(challenge);
  expect(authorize.searchParams.get("redirect_uri")).toEndWith("/v1/auth/apple/callback/app");
  // Apple's codes carry dots; this one's token carries the challenge as its nonce.
  const code = `code-a1.${codes++}.${challenge}`;
  const back = await s.app.request(`/v1/auth/apple/callback/app?code=${code}&state=${challenge}`);
  expect(back.headers.get("location")).toBe(`starbridge://auth?code=${code}&state=${challenge}`);
  // Someone who caught the code, with their own verifier, gets nothing, and the code is spent.
  const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const stolen = await s.call("POST", "/v1/auth/app/session", { body: { code, verifier: other } });
  expect(stolen.status).toBe(400);
  const code2 = `code-a1.${codes++}.${challenge}`;
  const ok = await s.call("POST", "/v1/auth/app/session", { body: { code: code2, verifier } });
  expect(ok.status).toBe(200);
  const web = await s.call("POST", "/v1/auth/apple/session", { body: signInBody("a1") });
  const me = async (t: string) => (await s.call("GET", "/v1/me", { token: t })).json.account;
  expect(await me(ok.json.session)).toBe(await me(web.json.session));
});

test("an app's Apple sign-in spends Apple's budget, not GitHub's", async () => {
  const s = await makeServer(appleConfig());
  const [n] = DEFAULT_LIMITS.githubCallbacks;
  for (let i = 0; i < n; i++) await s.app.request("/v1/auth/github/callback?code=x&state=y");
  expect((await s.app.request("/v1/auth/github/callback?code=x&state=y")).status).toBe(429);
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const code = `code-b1.${codes++}.${s256(verifier)}`;
  const r = await s.call("POST", "/v1/auth/app/session", { body: { code, verifier } });
  expect(r.status).toBe(200);
});

test("Apple's keys are fetched at most once a minute, so made-up key ids cost no fetch", async () => {
  let fetches = 0;
  const counting = ((url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/keys")) fetches++;
    return fetch(url, init);
  }) as typeof fetch;
  const a = new Apple(appleConfig().apple, counting);
  const forged = (kid: string) =>
    `${enc({ alg: "RS256", kid })}.${idToken("u9").split(".").slice(1).join(".")}`;
  try {
    const start = Date.now();
    setSystemTime(start);
    expect((await a.verify(idToken("u9"), [APP_ID])).sub).toBe("u9");
    expect(fetches).toBe(1);
    // Key ids unknown to keys fetched within the minute are refused without a fetch.
    await Promise.all(
      [1, 2, 3].map((n) =>
        expect(a.verify(forged(`x${n}`), [APP_ID])).rejects.toThrow(AppleRefused),
      ),
    );
    setSystemTime(start + 59_000);
    await expect(a.verify(forged("x4"), [APP_ID])).rejects.toThrow(AppleRefused);
    expect(fetches).toBe(1);
    expect((await a.verify(idToken("u9"), [APP_ID])).sub).toBe("u9");
    setSystemTime(start + 60_000);
    await expect(a.verify(forged("x5"), [APP_ID])).rejects.toThrow(AppleRefused);
    expect(fetches).toBe(2);
  } finally {
    setSystemTime();
  }
});
