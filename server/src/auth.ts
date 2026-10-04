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
  | { role: "device"; account: string; member: string | null; session: string }
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
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502,
  error: string,
  detail?: string,
): never {
  throw new HTTPException(status, {
    res: Response.json(detail ? { error, detail } : { error }, { status }),
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
  const token = bearer(c) ?? getCookie(c, SESSION_COOKIE);
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
  return { role: "device", account: s.account_id, member: s.member_id, session: hash };
}

type Need = "device" | "paired-device" | "machine" | "any" | "paired";

/**
 * Admits callers by role. "paired-device" needs a session bound to a device in the directory;
 * "paired" admits a paired device or a machine.
 */
export function requireCaller(...needs: Need[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const caller = identify(c);
    if (!caller) fail(401, "unauthenticated");
    const admits: Record<Need, boolean> = {
      any: true,
      device: caller.role === "device",
      "paired-device": caller.role === "device" && caller.member !== null,
      machine: caller.role === "machine",
      paired: caller.role === "machine" || caller.member !== null,
    };
    const ok = needs.some((n) => admits[n]);
    if (!ok) fail(403, "forbidden", `needs ${needs.join(" or ")}`);
    c.set("caller", caller);
    await next();
  };
}

/**
 * Identifies the caller again and fails unless it is still the one admitted. Write routes call
 * it inside their transaction, after the body arrived, so a revocation that landed while the
 * body was uploading still counts.
 */
export function recheck(c: Context<Env>): void {
  const now = identify(c);
  const was = c.var.caller;
  if (!now || now.role !== was.role || now.account !== was.account || now.member !== was.member)
    fail(401, "unauthenticated", "credentials changed during the request");
}

/** The member id of a caller admitted as paired. */
export function memberOf(caller: Caller): string {
  if (caller.member === null) fail(403, "forbidden", "not paired");
  return caller.member;
}
