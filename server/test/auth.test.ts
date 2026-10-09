import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSignUps } from "../src/signups";
import { DEFAULT_LIMITS, makeServer, setupAccount, signIn, testConfig } from "../test-support/app";

// A stand-in for GitHub's OAuth endpoints and user API.
let github: ReturnType<typeof Bun.serve>;
/** The redirect_uri of the last code exchange: GitHub requires the authorize request's. */
let exchangedFor = "";
/** Codes bound to a challenge work once, as all of GitHub's do. */
const used = new Set<string>();
const s256 = (verifier: string) =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
const githubUrl = () => `http://localhost:${github.port}`;

beforeAll(() => {
  github = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/login/oauth/access_token") {
        const body = (await req.json()) as {
          code: string;
          client_secret: string;
          redirect_uri: string;
          code_verifier?: string;
        };
        exchangedFor = body.redirect_uri;
        // code-<user>, or code-<user>-<challenge> for a code bound to a PKCE challenge.
        const [, user, challenge] = /^code-(\d+)(?:-(.+))?$/.exec(body.code) ?? [];
        const verified = !challenge || s256(body.code_verifier ?? "") === challenge;
        if (body.client_secret !== "gh-secret" || !user || !verified || used.has(body.code))
          return Response.json({ error: "bad_verification_code" });
        if (challenge) used.add(body.code);
        return Response.json({ access_token: `tok-${user}` });
      }
      if (url.pathname === "/user") {
        const auth = req.headers.get("authorization") ?? "";
        const user = auth.replace("Bearer tok-", "");
        return Response.json({ id: Number(user), login: `user${user}` });
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => github.stop());

function githubConfig() {
  return {
    github: {
      clientId: "gh-client",
      clientSecret: "gh-secret",
      authorizeUrl: `${githubUrl()}/login/oauth/authorize`,
      tokenUrl: `${githubUrl()}/login/oauth/access_token`,
      apiUrl: githubUrl(),
    },
  };
}

/** Runs the redirect dance the browser would, and returns the callback response. */
async function githubSignIn(
  s: Awaited<ReturnType<typeof makeServer>>,
  user: number,
  opts: { state?: string } = {},
) {
  const start = await s.app.request("/v1/auth/github");
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.searchParams.get("client_id")).toBe("gh-client");
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const state = opts.state ?? authorize.searchParams.get("state");
  const back = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  return s.app.request(`${back.pathname}?code=code-${user}&state=${state}`, {
    headers: { cookie },
  });
}

function sessionCookie(res: Response): string {
  const m = (res.headers.get("set-cookie") ?? "").match(/sb_session=([^;]+)/);
  if (!m?.[1]) throw new Error("no session cookie");
  return m[1];
}

test("GitHub sign-in sets an HTTP-only session cookie on one account per GitHub user", async () => {
  const s = await makeServer(githubConfig());
  const res = await githubSignIn(s, 42);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  const viaCookie = await s.app.request("/v1/me", {
    headers: { cookie: `sb_session=${sessionCookie(res)}` },
  });
  const first = (await viaCookie.json()) as { account: string; member: unknown; role: string };
  expect(first).toMatchObject({ role: "device", member: null });

  const again = await s.call("GET", "/v1/me", { token: sessionCookie(await githubSignIn(s, 42)) });
  const other = await s.call("GET", "/v1/me", { token: sessionCookie(await githubSignIn(s, 7)) });
  expect(again.json.account).toBe(first.account);
  expect(other.json.account).not.toBe(first.account);
});

/** RFC 7636 S256: the challenge is the base64url SHA-256 of the verifier. */
function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}

/** Starts the app's sign-in and returns where GitHub is asked to send it back. */
async function appStart(s: Awaited<ReturnType<typeof makeServer>>, challenge: string) {
  const start = await s.app.request(`/v1/auth/github?app=1&challenge=${challenge}`);
  expect(start.status).toBe(302);
  return new URL(start.headers.get("location") ?? "").searchParams;
}

test("the app's sign-in binds GitHub's code to its challenge and comes back to its own path", async () => {
  const s = await makeServer(githubConfig());
  const { challenge } = pkce();
  const authorize = await appStart(s, challenge);
  expect(authorize.get("redirect_uri")).toEndWith("/v1/auth/github/callback/app");
  expect(authorize.get("state")).toBe(challenge);
  expect(authorize.get("code_challenge")).toBe(challenge);
  expect(authorize.get("code_challenge_method")).toBe("S256");
  const page = new URL((await s.app.request("/v1/auth/github")).headers.get("location") ?? "");
  expect(page.searchParams.get("redirect_uri")).toEndWith("/v1/auth/github/callback");
  expect(page.searchParams.has("code_challenge")).toBe(false);
});

test("the app trades GitHub's code and its verifier for a session, once", async () => {
  const s = await makeServer(githubConfig());
  const { verifier, challenge } = pkce();
  const code = `code-42-${challenge}`;
  const r = await s.call("POST", "/v1/auth/app/session", { body: { code, verifier } });
  expect(r.status).toBe(200);
  expect(exchangedFor).toEndWith("/v1/auth/github/callback/app");
  const me = await s.call("GET", "/v1/me", { token: r.json.session });
  const web = await s.call("GET", "/v1/me", { token: sessionCookie(await githubSignIn(s, 42)) });
  expect(me.json.account).toBe(web.json.account);
  const again = await s.call("POST", "/v1/auth/app/session", { body: { code, verifier } });
  expect(again.status).toBe(400);
  expect(again.json.error).toBe("bad-code");
});

test("whoever catches the app's redirect cannot trade GitHub's code without the verifier", async () => {
  const s = await makeServer(githubConfig());
  const { challenge } = pkce();
  const r = await s.call("POST", "/v1/auth/app/session", {
    body: { code: `code-42-${challenge}`, verifier: pkce().verifier },
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe("bad-code");
});

test("the browser passes the app's sign-in on to the app, untouched", async () => {
  const s = await makeServer(githubConfig());
  const { challenge } = pkce();
  const res = await s.app.request(
    `/v1/auth/github/callback/app?code=code-42-${challenge}&state=${challenge}`,
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `starbridge://auth?code=code-42-${challenge}&state=${challenge}`,
  );
  expect(res.headers.get("set-cookie") ?? "").not.toContain("sb_session");
  const denied = await s.app.request(
    `/v1/auth/github/callback/app?error=access_denied&state=${challenge}`,
  );
  expect(denied.headers.get("location")).toBe(
    `starbridge://auth?error=access_denied&state=${challenge}`,
  );
  expect((await s.app.request("/v1/auth/github/callback/app?code=code-42")).status).toBe(400);
});

test("the page that passed the app's sign-in on learns only that it reached its own account (#943)", async () => {
  const s = await makeServer(githubConfig());
  const browser = await setupAccount(s, "brave", sessionCookie(await githubSignIn(s, 42)));
  const other = await setupAccount(s, "elsewhere", sessionCookie(await githubSignIn(s, 7)));
  const { verifier, challenge } = pkce();
  const ask = (token: string, state = challenge) =>
    s.call("GET", `/v1/auth/app/signed-in?state=${state}`, { token });
  expect((await ask(browser.device.token)).json).toEqual({ signedIn: false });
  const app = await s.call("POST", "/v1/auth/app/session", {
    body: { code: `code-42-${challenge}`, verifier },
  });
  expect(app.status).toBe(200);
  expect((await ask(browser.device.token)).json).toEqual({ signedIn: true });
  expect((await ask(other.device.token)).json).toEqual({ signedIn: false });
  expect((await ask(browser.device.token, pkce().challenge)).json).toEqual({ signedIn: false });
  expect((await ask(browser.device.token, "short")).status).toBe(400);
  // The app's own session, which holds no device yet, cannot ask.
  expect((await ask(app.json.session)).status).toBe(403);
});

test("paused sign-ups refuse new GitHub accounts and let existing ones in (#784)", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "sb-signups-")), "sb.db");
  const s = await makeServer({ ...githubConfig(), dbPath });
  expect((await githubSignIn(s, 42)).headers.get("location")).toBe("/");
  setSignUps(testConfig({ dbPath }), false);
  expect((await githubSignIn(s, 42)).headers.get("location")).toBe("/");
  const refused = await githubSignIn(s, 7);
  expect(refused.headers.get("location")).toBe("/?signin=paused");
  expect(refused.headers.get("set-cookie") ?? "").not.toContain("sb_session=sbs_");
  const { verifier, challenge } = pkce();
  const app = await s.call("POST", "/v1/auth/app/session", {
    body: { code: `code-8-${challenge}`, verifier },
  });
  expect(app.status).toBe(403);
  expect(app.json.error).toBe("signups-paused");
  setSignUps(testConfig({ dbPath }), true);
  expect((await githubSignIn(s, 7)).headers.get("location")).toBe("/");
});

test("new accounts are capped per address; existing ones still sign in (#787)", async () => {
  const s = await makeServer({
    ...githubConfig(),
    limits: { ...DEFAULT_LIMITS, signUps: [2, 3_600_000] },
  });
  for (const user of [101, 102])
    expect((await githubSignIn(s, user)).headers.get("location")).toBe("/");
  expect((await githubSignIn(s, 103)).headers.get("location")).toBe("/?signin=limited");
  expect((await githubSignIn(s, 101)).headers.get("location")).toBe("/");
});

test("app sign-in needs a challenge", async () => {
  const s = await makeServer(githubConfig());
  expect((await s.app.request("/v1/auth/github?app=1")).status).toBe(400);
});

test("a failed GitHub sign-in goes back to the page with why, and no session (#616)", async () => {
  const s = await makeServer(githubConfig());
  const res = await githubSignIn(s, 42, { state: "forged" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/?signin=expired");
  expect(res.headers.get("set-cookie") ?? "").not.toContain("sb_session=sbs_");
  const denied = await s.app.request("/v1/auth/github/callback?error=access_denied&state=x");
  expect(denied.headers.get("location")).toBe("/?signin=declined");
  const start = await s.app.request("/v1/auth/github");
  expect(start.headers.get("set-cookie")).toContain("Max-Age=3600");
});

test("GitHub sign-in is off without an OAuth app: the page says so, the app gets 404", async () => {
  const s = await makeServer();
  const page = await s.app.request("/v1/auth/github");
  expect(page.headers.get("location")).toBe("/?signin=off");
  expect((await s.call("GET", `/v1/auth/github?app=1&challenge=${pkce().challenge}`)).status).toBe(
    404,
  );
});

test("the server lists its sign-in methods (#670)", async () => {
  const methods = async (s: Awaited<ReturnType<typeof makeServer>>) =>
    (await (await s.app.request("/v1/auth/methods")).json()).methods;
  expect(await methods(await makeServer())).toEqual(["owner"]);
  expect(await methods(await makeServer(githubConfig()))).toContain("github");
});

test("owner sign-in refuses a wrong token and is rate-limited", async () => {
  const s = await makeServer();
  expect((await s.call("POST", "/v1/auth/owner", { body: { token: "nope" } })).status).toBe(401);
  for (let i = 0; i < 9; i++) await s.call("POST", "/v1/auth/owner", { body: { token: "nope" } });
  expect((await s.call("POST", "/v1/auth/owner", { body: { token: "owner-secret" } })).status).toBe(
    429,
  );
});

test("owner sign-in always lands on the one owner account", async () => {
  const s = await makeServer();
  const a = await s.call("GET", "/v1/me", { token: await signIn(s) });
  const b = await s.call("GET", "/v1/me", { token: await signIn(s) });
  expect(a.json.account).toBe(b.json.account);
  expect(a.json.account).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
});

test("owner sign-in is off without OWNER_TOKEN", async () => {
  const s = await makeServer({ ownerToken: undefined });
  expect((await s.call("POST", "/v1/auth/owner", { body: { token: "" } })).status).toBe(404);
});

test("/me refuses missing and unknown tokens", async () => {
  const s = await makeServer();
  expect((await s.call("GET", "/v1/me")).status).toBe(401);
  expect((await s.call("GET", "/v1/me", { token: "sbs_forged" })).status).toBe(401);
  expect((await s.call("GET", "/v1/me", { token: "sbm_forged" })).status).toBe(401);
});

test("logout ends the session", async () => {
  const s = await makeServer();
  const token = await signIn(s);
  expect((await s.call("POST", "/v1/auth/logout", { token })).status).toBe(204);
  expect((await s.call("GET", "/v1/me", { token })).status).toBe(401);
});

test("a cross-site form post carrying the cookie is refused", async () => {
  const s = await makeServer();
  const token = await signIn(s);
  const res = await s.app.request("/v1/auth/logout", {
    method: "POST",
    headers: {
      cookie: `sb_session=${token}`,
      origin: "https://evil.example",
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  expect(res.status).toBe(403);
  expect((await s.call("GET", "/v1/me", { token })).status).toBe(200);
});
