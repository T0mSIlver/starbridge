import { createHash } from "node:crypto";
import type { AppSignedIn } from "@starbridge/protocol";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { AppleRefused } from "../apple";
import {
  cookieName,
  createSession,
  deleteSessionCookie,
  fail,
  randomToken,
  requireCaller,
  safeEqual,
  setSessionCookie,
} from "../auth";
import type { Env } from "../env";
import { json } from "../http";
import { ipKey, rateLimit } from "../limits";
import { SIGNUPS_CLOSED, SIGNUPS_PAUSED, signUpsPaused } from "../signups";

const STATE_COOKIE = "sb_oauth";
/**
 * A random token the browser that started an app sign-in gets, which the server keeps with the
 * challenge (#1721): its return is bound to this browser only when the cookie comes back with it.
 * Not the challenge itself, which anyone who read it could send as a cookie.
 */
const APP_COOKIE = "sb_app";
/** The page's `signin` when this server has no GitHub sign-in. */
const SIGNIN_OFF = "off";
/** RFC 7636: a verifier is 43 to 128 unreserved characters; an S256 challenge is 43. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 S256: the challenge an app sent for this verifier. */
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/**
 * Starts an app sign-in in this browser. A challenge starts once: the browser that starts it gets
 * the cookie, and someone who read it from that browser's address later gets none.
 */
function startApp(c: Context<Env>, challenge: string): void {
  // Counted, as a flood of starts would fill the starts kept and refuse the next ones a cookie.
  rateLimit(c, `app-start:${ipKey(c)}`, c.var.config.limits.githubCallbacks);
  const token = randomToken("");
  if (!c.var.appSignIns.start(challenge, token, ipKey(c, 48))) return;
  setStateCookie(c, APP_COOKIE, token);
}

/**
 * An app's code came back through this browser: kept with its state, the app's challenge, and
 * whether this browser started that sign-in, for the trade to check.
 */
function passApp(c: Context<Env>, code: string, state: string): void {
  // Only the first code back binds, and only from the browser that started the sign-in.
  const cookie = getCookie(c, cookieName(c, APP_COOKIE));
  const bound = cookie !== undefined && c.var.appSignIns.takeStartToken(state, cookie);
  if (bound)
    deleteCookie(c, cookieName(c, APP_COOKIE), { path: "/", secure: c.var.config.secureCookies });
  if (!c.var.appSignIns.passed(code, state, bound, ipKey(c, 48)))
    fail(400, "bad-state", "sign-in came from elsewhere; start again in the app");
}

function newAccountId(): string {
  return randomToken("a").slice(0, 23);
}

export const authRoutes = new Hono<Env>();

/**
 * A sign-in's short-lived cookie, on path `/` as the `__Host-` name needs (`cookieName`). A
 * sign-in started before that name came in fails once and starts again.
 */
function setStateCookie(c: Context<Env>, name: string, value: string): void {
  setCookie(c, cookieName(c, name), value, {
    httpOnly: true,
    secure: c.var.config.secureCookies,
    sameSite: "Lax",
    path: "/",
    // Long enough to make a GitHub account, or pass 2FA or device verification (#616).
    maxAge: 3600,
  });
}

/** A sign-in's cookie, read once: it goes as it is read. */
function takeStateCookie(c: Context<Env>, name: string): string | undefined {
  const value = getCookie(c, cookieName(c, name));
  deleteCookie(c, cookieName(c, name), { path: "/", secure: c.var.config.secureCookies });
  return value;
}

/** The sign-in methods this server offers, so the page shows only those (#670). */
authRoutes.get("/auth/methods", (c) => {
  const { github, apple, ownerToken } = c.var.config;
  const methods = [
    ...(github ? ["github"] : []),
    // Apple's web sign-in; the iPhone app signs in with Apple natively on starbridge.run.
    ...(apple?.servicesId ? ["apple"] : []),
    ...(ownerToken ? ["owner"] : []),
  ];
  return c.json({ methods });
});

/**
 * Where GitHub sends a sign-in back. The app's sign-ins come back to their own path, which the
 * Android app claims as an App Link on starbridge.run: the installed web app's scope covers the
 * page's path, and Chrome would hand it the redirect (#527). The OAuth app lists both URLs:
 * GitHub refused the app's path while only the first was listed (#544).
 */
function callbackUrl(publicUrl: string, app: boolean, provider = "github"): string {
  return `${publicUrl}/v1/auth/${provider}/callback${app ? "/app" : ""}`;
}

/**
 * Starts GitHub sign-in. The app sends the S256 challenge of a verifier it keeps (RFC 7636), and
 * GitHub binds its code to it: only the app holding the verifier can trade the code, whoever
 * catches the redirect. The challenge is the app's state too, which the app checks.
 */
authRoutes.get("/auth/github", (c) => {
  const { github, publicUrl } = c.var.config;
  const app = c.req.query("app") === "1";
  if (!github) {
    if (app) fail(404, "not-configured", "GitHub sign-in is off on this server");
    return c.redirect(`/?signin=${SIGNIN_OFF}`);
  }
  const challenge = c.req.query("challenge") ?? "";
  if (app && !CHALLENGE.test(challenge))
    fail(400, "bad-request", "app sign-in needs challenge, the S256 PKCE challenge");
  const url = new URL(github.authorizeUrl);
  url.searchParams.set("client_id", github.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(publicUrl, app));
  url.searchParams.set("allow_signup", "true");
  if (app) {
    startApp(c, challenge);
    url.searchParams.set("state", challenge);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  } else {
    const state = randomToken("");
    url.searchParams.set("state", state);
    setStateCookie(c, STATE_COOKIE, state);
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

  // The page's sign-in is a navigation, which carries no client header; the apps send it.
  return accountFor(c, "github_id", user.id, verifier === undefined ? "web" : "app");
}

/**
 * The account a sign-in's provider id names, made on first sign-in unless sign-ups are paused,
 * the server lists who may sign up and this user isn't listed, or the address made too many. `column` is the provider's: `github_id` or `apple_sub`.
 */
function accountFor(
  c: Context<Env>,
  column: "github_id" | "apple_sub",
  id: number | string,
  via: string,
): string {
  const db = c.var.db;
  const existing = db.query(`SELECT id FROM accounts WHERE ${column} = ?`).get(id) as {
    id: string;
  } | null;
  if (existing) return existing.id;
  if (signUpsPaused(c.var.config)) fail(403, "signups-paused", SIGNUPS_PAUSED);
  // The clients already show `signups-paused` as "no new accounts here".
  const listed = c.var.config.signUpGitHubIds;
  if (listed && !(column === "github_id" && listed.has(id as number)))
    fail(403, "signups-paused", SIGNUPS_CLOSED);
  rateLimit(c, `signup:${ipKey(c)}`, c.var.config.limits.signUps);
  const account = newAccountId();
  db.query(`INSERT INTO accounts (id, ${column}, created_at) VALUES (?, ?, ?)`).run(
    account,
    id,
    new Date().toISOString(),
  );
  c.var.funnel.reached(c, account, "first-sign-in", { via: c.var.client?.name ?? via });
  return account;
}

/**
 * The page's sign-in comes back: the state must match the cookie it started with. A sign-in that
 * fails goes back to the page with why, in `signin`, which the page says in words with a way to
 * start again (#616): `declined` on GitHub, `expired` (or not matched to this browser), or `failed`.
 */
authRoutes.get("/auth/github/callback", async (c) => {
  rateLimit(c, `github:${ipKey(c)}`, c.var.config.limits.githubCallbacks);
  const back = (why: "declined" | "expired" | "failed" | "paused" | "limited") =>
    c.redirect(`/?signin=${why}`);
  const state = takeStateCookie(c, STATE_COOKIE);
  const code = c.req.query("code");
  if (c.req.query("error")) return back("declined");
  if (!state || !code || !safeEqual(state, c.req.query("state") ?? "")) return back("expired");
  let account: string;
  try {
    account = await gitHubAccount(c, code);
  } catch (e) {
    if (e instanceof HTTPException && e.status === 403) return back("paused");
    if (e instanceof HTTPException && e.status === 429) return back("limited");
    // GitHub refused, or could not be reached.
    if (!(e instanceof HTTPException)) console.error(`GitHub sign-in: ${e}`);
    return back("failed");
  }
  setSessionCookie(c, createSession(c.var.db, account, c.var.config.limits.sessions));
  return c.redirect("/");
});

/**
 * The browser got the app's sign-in back: the app was not there to catch it, or is too old to.
 * The server keeps the code's challenge, so the code is worthless without the app's verifier,
 * and passes it on to the app as it came, as it does GitHub's error, such as the owner turning
 * it down.
 */
authRoutes.get("/auth/github/callback/app", (c) => {
  const { appRedirectUri } = c.var.config;
  rateLimit(c, `github:${ipKey(c)}`, c.var.config.limits.githubCallbacks);
  const { code = "", error = "", state = "" } = c.req.query();
  const word = /^[A-Za-z0-9_-]{1,100}$/;
  if (!CHALLENGE.test(state) || !(word.test(code) || word.test(error)))
    fail(400, "bad-state", "sign-in came from elsewhere; start again in the app");
  if (word.test(code)) passApp(c, code, state);
  const sent = word.test(code) ? `code=${code}` : `error=${error}`;
  return c.redirect(`${appRedirectUri}?${sent}&state=${state}`);
});

/**
 * The app trades the code and the verifier behind its challenge for a session. GitHub binds its
 * code to the challenge; Apple signs the challenge into the identity token as its nonce, so an
 * Apple code, which has dots where GitHub's has none, must come back with the verifier's.
 */
authRoutes.post("/auth/app/session", async (c) => {
  // The endpoint's own limit comes before the body is read, so malformed bodies count too; each
  // provider's comes once the code says whose it is, so neither spends the other's.
  rateLimit(c, `app-session:${ipKey(c)}`, c.var.config.limits.appSessions);
  const { code, verifier } = await json(
    c,
    z.object({ code: z.string().min(1).max(APPLE_CODE_MAX), verifier: z.string().regex(VERIFIER) }),
  );
  // A code that came back through this server must be traded with its challenge's verifier,
  // whatever the provider checks: whoever caught the redirect after it has the code, not the
  // verifier, and a wrong guess leaves the code's challenge in place. The Mac app's must also
  // have come back to the browser that started its sign-in, since its challenge shows in that
  // browser's address and its code always passes through here.
  const passed = c.var.appSignIns.challengeOf(code);
  if (passed && !safeEqual(passed.challenge, s256(verifier)))
    fail(400, "bad-code", "sign-in code unknown, used, expired or not yours; sign in again");
  if (c.var.client?.name === "desktop" && !passed?.bound)
    fail(400, "bad-code", "sign-in came back to another browser; sign in again");
  let account: string;
  if (code.includes(".")) {
    rateLimit(c, `apple:${ipKey(c)}`, c.var.config.limits.appleSignIns);
    account = await appleAccount(
      c,
      "servicesId",
      code,
      callbackUrl(c.var.config.publicUrl, true, "apple"),
      {
        nonce: s256(verifier),
      },
    );
  } else {
    rateLimit(c, `github:${ipKey(c)}`, c.var.config.limits.githubCallbacks);
    if (code.length > 100) fail(400, "bad-code", "sign-in code unknown; sign in again");
    account = await gitHubAccount(c, code, verifier);
  }
  c.var.appSignIns.traded(code);
  c.var.appSignIns.add(s256(verifier), account);
  return c.json({ session: createSession(c.var.db, account, c.var.config.limits.sessions) });
});

/**
 * Whether the app whose sign-in this browser passed on now has a session of the browser's own
 * account (#943). The browser ran on the app's machine, so the page can offer to stop its own
 * notifications there, with no guess about which devices share a machine.
 */
authRoutes.get("/auth/app/signed-in", requireCaller("paired-device"), (c) => {
  const state = c.req.query("state") ?? "";
  if (!CHALLENGE.test(state)) fail(400, "bad-request", "state must be the app's challenge");
  const answer: AppSignedIn = {
    signedIn: c.var.appSignIns.reached(state, c.var.caller.account),
  };
  return c.json(answer);
});

/** Apple's codes are longer than GitHub's, with dots. */
const APPLE_CODE_MAX = 1024;
const APPLE_CODE = /^[A-Za-z0-9._-]{1,1024}$/;
const APPLE_STATE_COOKIE = "sb_apple";

/**
 * Trades an Apple code issued to the App ID or the Services ID, and returns its account, made on
 * first sign-in, keeping the refresh token, which deleting the account revokes. With the iPhone
 * app's identity token, the code must be the same user's; with an app's nonce alone, Apple must
 * have signed that nonce into the code's token. A code or token Apple refuses is a 400 `bad-code`.
 */
async function appleAccount(
  c: Context<Env>,
  client: "appId" | "servicesId",
  code: string,
  redirectUri?: string,
  /** The app's identity token and nonce, or the nonce Apple must have signed into the code's token. */
  proof?: { identityToken: string; nonce: string } | { nonce: string },
): Promise<string> {
  const apple = c.var.apple;
  const clientId = c.var.config.apple?.[client];
  if (!apple || !clientId) fail(404, "not-configured", "Apple sign-in is off on this server");
  let traded: Awaited<ReturnType<typeof apple.exchange>>;
  try {
    const shown =
      proof && "identityToken" in proof
        ? await apple.verify(proof.identityToken, [clientId], proof.nonce)
        : undefined;
    traded = await apple.exchange(clientId, code, redirectUri);
    if (shown && traded.identity.sub !== shown.sub)
      throw new AppleRefused("code is another user's");
    if (proof && !shown && !safeEqual(traded.identity.nonce ?? "", proof.nonce))
      throw new AppleRefused("code is not this verifier's");
  } catch (e) {
    if (e instanceof AppleRefused) fail(400, "bad-code", `Apple sign-in refused: ${e.message}`);
    console.error(`Apple sign-in: ${e}`);
    fail(502, "apple", "Apple could not be reached");
  }
  const account = accountFor(
    c,
    "apple_sub",
    traded.identity.sub,
    client === "appId" ? "app" : "web",
  );
  // Each sign-in's token stays valid at Apple, so each is kept to revoke (#1746).
  c.var.db
    .query("INSERT OR IGNORE INTO apple_tokens (token, client, account_id) VALUES (?, ?, ?)")
    .run(traded.refreshToken, clientId, account);
  return account;
}

/**
 * The iPhone app's Sign in with Apple (#1411): AuthenticationServices hands it an identity token
 * and an authorization code for the App ID. The token must carry the SHA-256 of the app's nonce;
 * trading the code, which works once, proves the token was not replayed.
 */
authRoutes.post("/auth/apple/session", async (c) => {
  rateLimit(c, `apple:${ipKey(c)}`, c.var.config.limits.appleSignIns);
  const { identityToken, code, nonce } = await json(
    c,
    z.object({
      identityToken: z.string().min(1).max(8192),
      code: z.string().min(1).max(APPLE_CODE_MAX),
      nonce: z.string().min(16).max(128),
    }),
  );
  const account = await appleAccount(c, "appId", code, undefined, {
    identityToken,
    nonce,
  });
  return c.json({ session: createSession(c.var.db, account, c.var.config.limits.sessions) });
});

/**
 * Starts Apple's web sign-in with the Services ID, for the page and, with `app=1`, the apps
 * other than the iPhone's, as GitHub's starts. No scope is asked, so no name or email, and Apple
 * answers with a plain redirect the state cookie (SameSite=Lax) comes back with.
 */
authRoutes.get("/auth/apple", (c) => {
  const { apple, publicUrl } = c.var.config;
  rateLimit(c, `apple-start:${ipKey(c)}`, c.var.config.limits.appleSignIns);
  const app = c.req.query("app") === "1";
  if (!apple?.servicesId) {
    if (app) fail(404, "not-configured", "Apple sign-in is off on this server");
    return c.redirect("/?signin=failed");
  }
  const challenge = c.req.query("challenge") ?? "";
  if (app && !CHALLENGE.test(challenge))
    fail(400, "bad-request", "app sign-in needs challenge, the S256 PKCE challenge");
  const state = app ? challenge : randomToken("");
  if (app) startApp(c, challenge);
  else setStateCookie(c, APPLE_STATE_COOKIE, state);
  const url = new URL(`${apple.url}/auth/authorize`);
  url.searchParams.set("client_id", apple.servicesId);
  url.searchParams.set("redirect_uri", callbackUrl(publicUrl, app, "apple"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("state", state);
  // Apple signs the nonce into the identity token: the app's challenge binds the code to it,
  // as GitHub's code_challenge does.
  if (app) url.searchParams.set("nonce", challenge);
  return c.redirect(url.toString());
});

/** The page's Apple sign-in comes back, as GitHub's does, with the same `signin` failures. */
authRoutes.get("/auth/apple/callback", async (c) => {
  const { publicUrl } = c.var.config;
  rateLimit(c, `apple:${ipKey(c)}`, c.var.config.limits.appleSignIns);
  const back = (why: "declined" | "expired" | "failed" | "paused" | "limited") =>
    c.redirect(`/?signin=${why}`);
  const state = takeStateCookie(c, APPLE_STATE_COOKIE);
  const code = c.req.query("code") ?? "";
  if (c.req.query("error")) return back("declined");
  if (!state || !APPLE_CODE.test(code) || !safeEqual(state, c.req.query("state") ?? ""))
    return back("expired");
  let account: string;
  try {
    account = await appleAccount(c, "servicesId", code, callbackUrl(publicUrl, false, "apple"));
  } catch (e) {
    if (e instanceof HTTPException && e.status === 403) return back("paused");
    if (e instanceof HTTPException && e.status === 429) return back("limited");
    return back("failed");
  }
  setSessionCookie(c, createSession(c.var.db, account, c.var.config.limits.sessions));
  return c.redirect("/");
});

/**
 * An app's Apple sign-in comes back. No app claims this path, so the code goes on to
 * `APP_REDIRECT_URI`, as GitHub's: it is worthless without the verifier whose challenge Apple
 * signed in as the nonce.
 */
authRoutes.get("/auth/apple/callback/app", (c) => {
  const { appRedirectUri } = c.var.config;
  rateLimit(c, `apple-start:${ipKey(c)}`, c.var.config.limits.appleSignIns);
  const { code = "", error = "", state = "" } = c.req.query();
  if (!CHALLENGE.test(state) || !(APPLE_CODE.test(code) || /^[A-Za-z0-9_-]{1,100}$/.test(error)))
    fail(400, "bad-state", "sign-in came from elsewhere; start again in the app");
  if (APPLE_CODE.test(code)) passApp(c, code, state);
  const sent = APPLE_CODE.test(code) ? `code=${code}` : `error=${error}`;
  return c.redirect(`${appRedirectUri}?${sent}&state=${state}`);
});

/** Self-hosted sign-in with OWNER_TOKEN; the session also comes back for the Android app. */
authRoutes.post("/auth/owner", async (c) => {
  const { ownerToken } = c.var.config;
  if (!ownerToken) fail(404, "not-configured", "owner sign-in is off on this server");
  rateLimit(c, `owner:${ipKey(c)}`, c.var.config.limits.ownerSignIns);
  const { token } = await json(c, z.object({ token: z.string().max(1000) }));
  if (!safeEqual(token, ownerToken)) fail(401, "unauthenticated", "wrong owner token");
  const db = c.var.db;
  const existing = db.query("SELECT id FROM accounts WHERE owner = 1").get() as {
    id: string;
  } | null;
  // The owner token is a secret its operator set, so it makes the owner account on a server with a
  // sign-up list too (#1621): staging's app check starts from an empty account and deletes it.
  const account = existing?.id ?? newAccountId();
  if (!existing)
    db.query("INSERT INTO accounts (id, owner, created_at) VALUES (?, 1, ?)").run(
      account,
      new Date().toISOString(),
    );
  const session = createSession(db, account, c.var.config.limits.sessions);
  setSessionCookie(c, session);
  return c.json({ session });
});

/**
 * Signs this device out. Its push subscriptions go with its last session (security audit
 * 2026-10-20): the push service would otherwise keep getting its items, sealed, until the client
 * unsubscribed, which a client that lost its storage never does.
 */
authRoutes.post("/auth/logout", requireCaller("device"), (c) => {
  const caller = c.var.caller;
  const db = c.var.db;
  if (caller.role === "device")
    db.transaction(() => {
      db.query("DELETE FROM sessions WHERE token_hash = ?").run(caller.session);
      if (caller.member === null) return;
      const left = db
        .query("SELECT 1 FROM sessions WHERE account_id = ? AND member_id = ?")
        .get(caller.account, caller.member);
      if (!left)
        db.query("DELETE FROM push_subscriptions WHERE account_id = ? AND member_id = ?").run(
          caller.account,
          caller.member,
        );
    })();
  deleteSessionCookie(c);
  return c.body(null, 204);
});

authRoutes.get("/me", requireCaller("any"), (c) => {
  const { role, account, member } = c.var.caller;
  return c.json({ account, member, role });
});
