import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  createSession,
  fail,
  randomToken,
  requireCaller,
  SESSION_COOKIE,
  safeEqual,
} from "../auth";
import type { Env } from "../env";
import { json } from "../http";
import { ipKey, rateLimit } from "../limits";

const STATE_COOKIE = "sb_oauth";
/** RFC 7636: a verifier is 43 to 128 unreserved characters; an S256 challenge is 43. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function newAccountId(): string {
  return randomToken("a").slice(0, 23);
}

export const authRoutes = new Hono<Env>();

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: 365 * 86_400,
  });
}

/**
 * Where GitHub sends a sign-in back. The app's sign-ins come back to their own path, which the
 * Android app claims as an App Link on starbridge.run: the installed web app's scope covers the
 * page's path, and Chrome would hand it the redirect (#527). The OAuth app lists both URLs:
 * GitHub refused the app's path while only the first was listed (#544).
 */
function callbackUrl(publicUrl: string, app: boolean): string {
  return `${publicUrl}/v1/auth/github/callback${app ? "/app" : ""}`;
}

/**
 * Starts GitHub sign-in. The app sends the S256 challenge of a verifier it keeps (RFC 7636), and
 * GitHub binds its code to it: only the app holding the verifier can trade the code, whoever
 * catches the redirect. The challenge is the app's state too, which the app checks.
 */
authRoutes.get("/auth/github", (c) => {
  const { github, publicUrl, secureCookies } = c.var.config;
  if (!github) fail(404, "not-configured", "GitHub sign-in is off on this server");
  const app = c.req.query("app") === "1";
  const challenge = c.req.query("challenge") ?? "";
  if (app && !CHALLENGE.test(challenge))
    fail(400, "bad-request", "app sign-in needs challenge, the S256 PKCE challenge");
  const url = new URL(github.authorizeUrl);
  url.searchParams.set("client_id", github.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(publicUrl, app));
  url.searchParams.set("allow_signup", "true");
  if (app) {
    url.searchParams.set("state", challenge);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  } else {
    const state = randomToken("");
    url.searchParams.set("state", state);
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "Lax",
      path: "/v1/auth/github",
      maxAge: 600,
    });
  }
  return c.redirect(url.toString());
});

/**
 * Trades GitHub's code, with the PKCE verifier for the app's, and returns the user's account,
 * made on first sign-in. A code GitHub refuses is a 400 `bad-code`.
 */
async function gitHubAccount(c: Context<Env>, code: string, verifier?: string): Promise<string> {
  const { github, publicUrl } = c.var.config;
  if (!github) fail(404, "not-configured", "GitHub sign-in is off on this server");
  const tokenRes = await fetch(github.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: github.clientId,
      client_secret: github.clientSecret,
      code,
      redirect_uri: callbackUrl(publicUrl, verifier !== undefined),
      ...(verifier !== undefined && { code_verifier: verifier }),
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  // GitHub answers 200 with an error for a code that is unknown, used, expired or not this
  // verifier's.
  if (tokenRes.ok && token.error === "bad_verification_code")
    fail(400, "bad-code", "sign-in code unknown, used, expired or not yours; sign in again");
  if (!tokenRes.ok || !token.access_token) fail(502, "github", "code exchange failed");
  const userRes = await fetch(`${github.apiUrl}/user`, {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "starbridge",
    },
  });
  const user = (await userRes.json().catch(() => ({}))) as { id?: unknown };
  if (!userRes.ok || typeof user.id !== "number") fail(502, "github", "user lookup failed");

  const db = c.var.db;
  const existing = db.query("SELECT id FROM accounts WHERE github_id = ?").get(user.id) as {
    id: string;
  } | null;
  const account = existing?.id ?? newAccountId();
  if (!existing)
    db.query("INSERT INTO accounts (id, github_id, created_at) VALUES (?, ?, ?)").run(
      account,
      user.id,
      new Date().toISOString(),
    );
  return account;
}

/** The page's sign-in comes back: the state must match the cookie it started with. */
authRoutes.get("/auth/github/callback", async (c) => {
  const { secureCookies } = c.var.config;
  rateLimit(c, `github:${ipKey(c)}`, c.var.config.limits.githubCallbacks);
  // Before #527 the cookie also held the app flag and challenge: an app sign-in started then
  // cannot finish here.
  const [state, app] = (getCookie(c, STATE_COOKIE) ?? "").split(".");
  deleteCookie(c, STATE_COOKIE, { path: "/v1/auth/github" });
  const code = c.req.query("code");
  if (!state || !code || app === "1" || !safeEqual(state, c.req.query("state") ?? ""))
    fail(400, "bad-state", "sign-in expired or came from elsewhere; start again");
  const token = createSession(c.var.db, await gitHubAccount(c, code), c.var.config.limits.sessions);
  setSessionCookie(c, token, secureCookies);
  return c.redirect("/");
});

/**
 * The browser got the app's sign-in back: the app was not there to catch it, or is too old to.
 * GitHub's code is worthless without the app's verifier, so it goes on to the app as it came, and
 * so does GitHub's error, such as the owner turning it down.
 */
authRoutes.get("/auth/github/callback/app", (c) => {
  const { appRedirectUri } = c.var.config;
  const { code = "", error = "", state = "" } = c.req.query();
  const word = /^[A-Za-z0-9_-]{1,100}$/;
  if (!CHALLENGE.test(state) || !(word.test(code) || word.test(error)))
    fail(400, "bad-state", "sign-in came from elsewhere; start again in the app");
  const sent = word.test(code) ? `code=${code}` : `error=${error}`;
  return c.redirect(`${appRedirectUri}?${sent}&state=${state}`);
});

/** The app trades GitHub's code and the verifier behind its challenge for a session. */
authRoutes.post("/auth/app/session", async (c) => {
  rateLimit(c, `github:${ipKey(c)}`, c.var.config.limits.githubCallbacks);
  const { code, verifier } = await json(
    c,
    z.object({ code: z.string().min(1).max(100), verifier: z.string().regex(VERIFIER) }),
  );
  const account = await gitHubAccount(c, code, verifier);
  return c.json({ session: createSession(c.var.db, account, c.var.config.limits.sessions) });
});

/** Self-hosted sign-in with OWNER_TOKEN; the session also comes back for the Android app. */
authRoutes.post("/auth/owner", async (c) => {
  const { ownerToken, secureCookies } = c.var.config;
  if (!ownerToken) fail(404, "not-configured", "owner sign-in is off on this server");
  rateLimit(c, `owner:${ipKey(c)}`, [10, 60_000]);
  const { token } = await json(c, z.object({ token: z.string().max(1000) }));
  if (!safeEqual(token, ownerToken)) fail(401, "unauthenticated", "wrong owner token");
  const db = c.var.db;
  const existing = db.query("SELECT id FROM accounts WHERE owner = 1").get() as {
    id: string;
  } | null;
  const account = existing?.id ?? newAccountId();
  if (!existing)
    db.query("INSERT INTO accounts (id, owner, created_at) VALUES (?, 1, ?)").run(
      account,
      new Date().toISOString(),
    );
  const session = createSession(db, account, c.var.config.limits.sessions);
  setSessionCookie(c, session, secureCookies);
  return c.json({ session });
});

authRoutes.post("/auth/logout", requireCaller("device"), (c) => {
  const caller = c.var.caller;
  if (caller.role === "device")
    c.var.db.query("DELETE FROM sessions WHERE token_hash = ?").run(caller.session);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});

authRoutes.get("/me", requireCaller("any"), (c) => {
  const { role, account, member } = c.var.caller;
  return c.json({ account, member, role });
});
