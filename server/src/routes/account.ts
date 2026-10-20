import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { deleteSessionCookie, randomToken, requireCaller } from "../auth";
import type { Deps, Env } from "../env";
import { ipKey, rateLimit } from "../limits";
import { forgetChallenges } from "./bind";

/**
 * Tables holding an account's rows, children first. The triggers on `items` leave `item_totals`
 * rows at zero, which go after them.
 */
export const ACCOUNT_TABLES = [
  "boxes",
  "items",
  "item_totals",
  "push_subscriptions",
  "joins",
  "pairings",
  "machine_tokens",
  "revoked_sessions",
  "sessions",
  "members",
  "directory",
] as const;

/**
 * Deletes everything the database holds for `account` (#1104), and returns the ids of what
 * waits on it. Today's usage events keep their count under a random subject, so no row names the
 * account; the sessions go without a `revoked_sessions` row, which would only say why.
 */
export function deleteAccount(
  db: Database,
  account: string,
): {
  members: string[];
  joins: string[];
  rendezvous: string[];
  sessions: string[];
} | null {
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM accounts WHERE id = ?").get(account)) return null;
    const ids = (sql: string) => (db.query(sql).all(account) as { id: string }[]).map((r) => r.id);
    const waits = {
      members: ids("SELECT id FROM members WHERE account_id = ?"),
      joins: ids("SELECT id FROM joins WHERE account_id = ?"),
      rendezvous: ids("SELECT rendezvous AS id FROM pairings WHERE account_id = ?"),
      sessions: ids("SELECT token_hash AS id FROM sessions WHERE account_id = ?"),
    };
    // Its Apple refresh tokens, and the one an account from before #1746 holds itself, stay under
    // no account until Apple confirms each revoked.
    db.query(
      `INSERT OR IGNORE INTO apple_tokens (token, client, account_id)
       SELECT apple_refresh_token, apple_client, id FROM accounts
       WHERE id = ? AND apple_refresh_token IS NOT NULL AND apple_client IS NOT NULL`,
    ).run(account);
    db.query("UPDATE apple_tokens SET account_id = NULL, due_at = ? WHERE account_id = ?").run(
      Date.now(),
      account,
    );
    for (const table of ACCOUNT_TABLES)
      db.query(`DELETE FROM ${table} WHERE account_id = ?`).run(account);
    // A subject is the account id, or the account id, a slash and a member id. Each distinct one
    // gets its own random stand-in, which names neither.
    const subjects = db
      .query(
        `SELECT DISTINCT subject FROM usage_events
         WHERE subject = ?1 OR substr(subject, 1, length(?1) + 1) = ?1 || '/'`,
      )
      .all(account) as { subject: string }[];
    const rename = db.query("UPDATE usage_events SET subject = ? WHERE subject = ?");
    for (const { subject } of subjects) rename.run(randomToken("gone_"), subject);
    db.query("DELETE FROM accounts WHERE id = ?").run(account);
    return waits;
  })();
}

/** Forgets what memory holds for the account, and ends its waits: each rechecks and gets 401. */
function forgetAccount(
  deps: Deps,
  account: string,
  waits: NonNullable<ReturnType<typeof deleteAccount>>,
) {
  deps.presence.forget(account);
  deps.appSignIns.forget(account);
  deps.usage.forget(account);
  deps.limiter.forget(account);
  deps.quotaAsks.delete(account);
  deps.watch.forget(account);
  forgetChallenges(waits.sessions);
  for (const m of waits.members) deps.answers.wake(`${account}/${m}`);
  deps.quotas.wake(account);
  deps.joins.wake(`account:${account}`);
  for (const j of waits.joins) deps.joins.wake(`join:${j}`);
  for (const r of waits.rendezvous) deps.pairings.wake(r);
  // Apple asks an app that deletes an account to revoke its Sign in with Apple tokens, which
  // takes Starbridge off the user's Apple ID. The account is gone either way.
  deps.apple?.revokeDue(deps.db);
}

export const accountRoutes = new Hono<Env>();

/**
 * Deletes the caller's account and signs out every session and machine. Any signed-in session
 * may, paired or not: an app must let whoever signed in delete the account (App Store
 * 5.1.1(v)), and the sign-in that makes a session already controls the account.
 */
accountRoutes.delete("/account", requireCaller("device"), (c) => {
  const { account } = c.var.caller;
  rateLimit(c, `delete-account:${ipKey(c)}`, c.var.config.limits.accountDeletes);
  const waits = deleteAccount(c.var.db, account);
  if (waits) forgetAccount(c.var, account, waits);
  deleteSessionCookie(c);
  return c.body(null, 204);
});
