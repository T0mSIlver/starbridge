import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeServer, signIn } from "../test-support/app";

// A stand-in for GitHub's OAuth endpoints and user API.
let github: ReturnType<typeof Bun.serve>;
/** The redirect_uri of the last code exchange: GitHub requires the authorize request's. */
let exchangedFor = "";
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
        };
        exchangedFor = body.redirect_uri;
        if (body.client_secret !== "gh-secret" || !body.code.startsWith("code-"))
          return Response.json({ error: "bad_verification_code" });
        return Response.json({ access_token: `tok-${body.code.slice(5)}` });
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
  opts: { challenge?: string; state?: string } = {},
) {
  const query = opts.challenge ? `?app=1&challenge=${opts.challenge}` : "";
  const start = await s.app.request(`/v1/auth/github${query}`);
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
  const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function appSignIn(s: Awaited<ReturnType<typeof makeServer>>, user: number) {
  const { verifier, challenge } = pkce();
  const res = await githubSignIn(s, user, { challenge });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  return { location, code: location.searchParams.get("code") ?? "", verifier };
}

test("GitHub sign-in for the app redirects with a code, never the session", async () => {
  const s = await makeServer(githubConfig());
  const { location, code } = await appSignIn(s, 42);
  expect(location.protocol + location.host + location.pathname).toBe("starbridge:auth");
  expect(location.href).not.toContain("sbs_");
  expect(code).toStartWith("sbc_");
  expect((await s.call("GET", "/v1/me", { token: code })).status).toBe(401);
});

test("the app's sign-ins come back to their own path, with the challenge as state", async () => {
  const s = await makeServer(githubConfig());
  const { challenge } = pkce();
  const start = await s.app.request(`/v1/auth/github?app=1&challenge=${challenge}`);
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.searchParams.get("redirect_uri")).toEndWith("/v1/auth/github/callback/app");
  expect(authorize.searchParams.get("state")).toBe(challenge);
  const page = new URL((await s.app.request("/v1/auth/github")).headers.get("location") ?? "");
  expect(page.searchParams.get("redirect_uri")).toEndWith("/v1/auth/github/callback");
});

test("the app that caught GitHub's redirect trades its code with the verifier", async () => {
  const s = await makeServer(githubConfig());
  const { verifier, challenge } = pkce();
  const r = await s.call("POST", "/v1/auth/app/github", {
    body: { code: "code-42", state: challenge, verifier },
  });
  expect(r.status).toBe(200);
  expect(exchangedFor).toEndWith("/v1/auth/github/callback/app");
  const me = await s.call("GET", "/v1/me", { token: r.json.session });
  const web = await s.call("GET", "/v1/me", { token: sessionCookie(await githubSignIn(s, 42)) });
  expect(me.json.account).toBe(web.json.account);
});

test("GitHub's code is worthless to the app without the verifier behind the state", async () => {
  const s = await makeServer(githubConfig());
  const { challenge } = pkce();
  const r = await s.call("POST", "/v1/auth/app/github", {
    body: { code: "code-42", state: challenge, verifier: pkce().verifier },
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe("bad-state");
});

test("the app trades its code and verifier for a session, once", async () => {
  const s = await makeServer(githubConfig());
  const { code, verifier } = await appSignIn(s, 42);
  const r = await s.call("POST", "/v1/auth/app/session", { body: { code, verifier } });
  expect(r.status).toBe(200);
  const me = await s.call("GET", "/v1/me", { token: r.json.session });
  expect(me.json).toMatchObject({ role: "device", member: null });
  const again = await s.call("POST", "/v1/auth/app/session", { body: { code, verifier } });
  expect(again.status).toBe(400);
});

test("an app that caught the redirect cannot trade the code without the verifier", async () => {
  const s = await makeServer(githubConfig());
  const { code, verifier } = await appSignIn(s, 42);
  const stolen = await s.call("POST", "/v1/auth/app/session", {
    body: { code, verifier: pkce().verifier },
  });
  expect(stolen.status).toBe(400);
  // A failed try burns the code, so the thief cannot keep guessing.
  const late = await s.call("POST", "/v1/auth/app/session", { body: { code, verifier } });
  expect(late.status).toBe(400);
});

test("app sign-in needs a challenge and its code expires", async () => {
  const s = await makeServer(githubConfig());
  expect((await s.app.request("/v1/auth/github?app=1")).status).toBe(400);
  const { code, verifier } = await appSignIn(s, 42);
  s.deps.db.query("UPDATE app_codes SET expires_at = 0").run();
  const r = await s.call("POST", "/v1/auth/app/session", { body: { code, verifier } });
  expect(r.status).toBe(400);
});

test("GitHub sign-in refuses a callback whose state does not match", async () => {
  const s = await makeServer(githubConfig());
  const res = await githubSignIn(s, 42, { state: "forged" });
  expect(res.status).toBe(400);
  expect(res.headers.get("set-cookie") ?? "").not.toContain("sb_session=sbs_");
});

test("GitHub sign-in is off without an OAuth app", async () => {
  const s = await makeServer();
  expect((await s.call("GET", "/v1/auth/github")).status).toBe(404);
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
