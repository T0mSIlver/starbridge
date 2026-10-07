import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { toB64 } from "@starbridge/protocol";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./env";

export const SESSION_COOKIE = "sb_session";
const SESSION_DAYS = 365;

export type Caller =
  | {
      role: "device";
      account: string;
      member: string | null;
      session: string;
      /** The web page signs in with the cookie; the Android app sends a bearer token. */
      client: "web" | "android";
    }
  | { role: "machine"; account: string; member: string };

export function randomToken(prefix: string): string {
  return prefix + toB64(crypto.getRandomValues(new Uint8Array(32)));
}

/** Tokens are 256 random bits, so a plain SHA-256 is enough to store them. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function fail(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503,
  error: string,
  detail?: string,
  headers?: Record<string, string>,
): never {
  throw new HTTPException(status, {
    res: Response.json(detail ? { error, detail } : { error }, { status, headers }),
  });
}

/** Starts a session; past `max` sessions on the account, the oldest end. */
export function createSession(db: Database, account: string, max: number): string {
  const token = randomToken("sbs_");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  db.query(
    "INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hashToken(token), account, now.toISOString(), expires.toISOString());
  // Signing in again and again would pile up sessions: end the oldest past the cap, unpaired
  // ones first, since a paired one may be a device still in use.
  db.query(
    `DELETE FROM sessions WHERE token_hash IN (
       SELECT token_hash FROM sessions WHERE account_id = ? AND token_hash != ?
       ORDER BY member_id IS NULL DESC, created_at ASC
       LIMIT max(0, (SELECT COUNT(*) FROM sessions WHERE account_id = ?) - ?))`,
  ).run(account, hashToken(token), account, max);
  return token;
}

function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/** Reads the caller from the bearer token or the session cookie, if any. */
export function identify(c: Context<Env>): Caller | undefined {
  const db = c.var.db;
  const sent = bearer(c);
  const token = sent ?? getCookie(c, SESSION_COOKIE);
  if (!token) return undefined;
  const hash = hashToken(token);
  if (token.startsWith("sbm_")) {
    const m = db
      .query("SELECT account_id, member_id FROM machine_tokens WHERE token_hash = ?")
      .get(hash) as { account_id: string; member_id: string } | null;
    return m ? { role: "machine", account: m.account_id, member: m.member_id } : undefined;
  }
  const s = db
    .query("SELECT account_id, member_id, expires_at FROM sessions WHERE token_hash = ?")
    .get(hash) as { account_id: string; member_id: string | null; expires_at: string } | null;
  if (!s || s.expires_at < new Date().toISOString()) return undefined;
  return {
    role: "device",
    account: s.account_id,
    member: s.member_id,
    session: hash,
    client: sent ? "android" : "web",
  };
}

export const ACCOUNT_SUSPENDED =
  "this account's machines are suspended for abuse of starbridge.run; its phones and browsers still work. Write to abuse@starbridge.run";

/** A machine of a suspended account may read, never write. */
function refuseSuspended(c: Context<Env>, caller: Caller): void {
  if (caller.role !== "machine" || ["GET", "HEAD"].includes(c.req.method)) return;
  const row = c.var.db
    .query("SELECT suspended_at FROM accounts WHERE id = ?")
    .get(caller.account) as { suspended_at: string | null } | null;
  if (row?.suspended_at) fail(403, "account-suspended", ACCOUNT_SUSPENDED);
}

/** Suspends an account's machines, or lifts it; false when no such account. */
export function setSuspended(db: Database, account: string, on: boolean): boolean {
  return (
    db
      .query("UPDATE accounts SET suspended_at = ? WHERE id = ?")
      .run(on ? new Date().toISOString() : null, account).changes === 1
  );
}

/** The caller's session belonged to a device the directory has since revoked. */
function wasRevoked(c: Context<Env>): boolean {
  const token = bearer(c) ?? getCookie(c, SESSION_COOKIE);
  if (!token) return false;
  return !!c.var.db
    .query("SELECT 1 FROM revoked_sessions WHERE token_hash = ? AND expires_at >= ?")
    .get(hashToken(token), new Date().toISOString());
}

type Need = "device" | "paired-device" | "machine" | "any" | "paired";

/**
 * Admits callers by role. "paired-device" needs a session bound to a device in the directory;
 * "paired" admits a paired device or a machine.
 */
export function requireCaller(...needs: Need[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const caller = identify(c);
    if (!caller) fail(401, wasRevoked(c) ? "revoked" : "unauthenticated");
    const admits: Record<Need, boolean> = {
      any: true,
      device: caller.role === "device",
      "paired-device": caller.role === "device" && caller.member !== null,
      machine: caller.role === "machine",
      paired: caller.role === "machine" || caller.member !== null,
    };
    const ok = needs.some((n) => admits[n]);
    if (!ok) fail(403, "forbidden", `needs ${needs.join(" or ")}`);
    // A suspended account's machines read and wait as before, so their sessions see the answers
    // already given; they write nothing. Its devices are untouched, so the owner can still
    // answer, settle and revoke (#785).
    refuseSuspended(c, caller);
    c.set("caller", caller);
    c.var.usage.seen(caller, c.var.client);
    await next();
  };
}

/**
 * Identifies the caller again and fails unless it is still the one admitted. Write routes call
 * it inside their transaction, after the body arrived, and long-polls after their wait, so a
 * revocation that landed in between still counts.
 */
export function recheck(c: Context<Env>): void {
  const now = identify(c);
  const was = c.var.caller;
  if (!now || now.role !== was.role || now.account !== was.account || now.member !== was.member)
    fail(401, "unauthenticated", "credentials changed during the request");
  // A suspension that landed while the body arrived still counts.
  refuseSuspended(c, now);
}

/** The member id of a caller admitted as paired. */
export function memberOf(caller: Caller): string {
  if (caller.member === null) fail(403, "forbidden", "not paired");
  return caller.member;
}
