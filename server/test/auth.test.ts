import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeServer, signIn } from "../test-support/app";

// A stand-in for GitHub's OAuth endpoints and user API.
let github: ReturnType<typeof Bun.serve>;
const githubUrl = () => `http://localhost:${github.port}`;

beforeAll(() => {
  github = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/login/oauth/access_token") {
        const body = (await req.json()) as { code: string; client_secret: string };
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
  opts: { app?: boolean; state?: string } = {},
) {
  const start = await s.app.request(`/v1/auth/github${opts.app ? "?app=1" : ""}`);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.searchParams.get("client_id")).toBe("gh-client");
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const state = opts.state ?? authorize.searchParams.get("state");
  return s.app.request(`/v1/auth/github/callback?code=code-${user}&state=${state}`, {
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

test("GitHub sign-in for the app puts the session in the redirect fragment", async () => {
  const s = await makeServer(githubConfig());
  const res = await githubSignIn(s, 42, { app: true });
  const location = res.headers.get("location") ?? "";
  expect(location).toStartWith("starbridge://auth#session=sbs_");
  const me = await s.call("GET", "/v1/me", { token: location.split("session=")[1] });
  expect(me.status).toBe(200);
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
