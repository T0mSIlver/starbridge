import { Hono } from "hono";
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
import { clientIp, json } from "../http";

const STATE_COOKIE = "sb_oauth";

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

authRoutes.get("/auth/github", (c) => {
  const { github, publicUrl, secureCookies } = c.var.config;
  if (!github) fail(404, "not-configured", "GitHub sign-in is off on this server");
  const state = randomToken("");
  const app = c.req.query("app") === "1";
  setCookie(c, STATE_COOKIE, `${state}.${app ? 1 : 0}`, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "Lax",
    path: "/v1/auth/github",
    maxAge: 600,
  });
  const url = new URL(github.authorizeUrl);
  url.searchParams.set("client_id", github.clientId);
  url.searchParams.set("redirect_uri", `${publicUrl}/v1/auth/github/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return c.redirect(url.toString());
});

authRoutes.get("/auth/github/callback", async (c) => {
  const { github, publicUrl, secureCookies, appRedirectUri } = c.var.config;
  if (!github) fail(404, "not-configured", "GitHub sign-in is off on this server");
  const [state, app] = (getCookie(c, STATE_COOKIE) ?? "").split(".");
  deleteCookie(c, STATE_COOKIE, { path: "/v1/auth/github" });
  const code = c.req.query("code");
  if (!state || !code || !safeEqual(state, c.req.query("state") ?? ""))
    fail(400, "bad-state", "sign-in expired or came from elsewhere; start again");

  const tokenRes = await fetch(github.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: github.clientId,
      client_secret: github.clientSecret,
      code,
      redirect_uri: `${publicUrl}/v1/auth/github/callback`,
    }),
  });
  const { access_token } = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !access_token) fail(502, "github", "code exchange failed");
  const userRes = await fetch(`${github.apiUrl}/user`, {
    headers: {
      authorization: `Bearer ${access_token}`,
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
  const token = createSession(db, account);
  if (app === "1") return c.redirect(`${appRedirectUri}#session=${token}`);
  setSessionCookie(c, token, secureCookies);
  return c.redirect("/");
});

/** Self-hosted sign-in with OWNER_TOKEN; the session also comes back for the Android app. */
authRoutes.post("/auth/owner", async (c) => {
  const { ownerToken, secureCookies } = c.var.config;
  if (!ownerToken) fail(404, "not-configured", "owner sign-in is off on this server");
  if (!c.var.limiter.allow(`owner:${clientIp(c)}`, 10, 60_000)) fail(429, "rate-limited");
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
  const session = createSession(db, account);
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
