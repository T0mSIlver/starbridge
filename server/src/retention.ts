import type { Database } from "bun:sqlite";
import type { Limits } from "./limits";

/**
 * Drops what no client needs any more: answered decisions and their answers a week after the
 * answer, permission prompts with their answers and settled notices a week after they arrive
 * (the clients' log shows that week), runs a day after their last update, a decision's waiting state with the decision, unanswered decisions
 * and unreplaced quota snapshots after 30 days, quota snapshots of revoked machines, expired sessions and expired app sign-in codes. Boxes go with their items.
 */
export function sweepStorage(db: Database, limits: Limits, now = Date.now()): void {
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const answered = iso(limits.answeredRetention);
  const stale = iso(limits.staleRetention);
  const runs = iso(limits.runRetention);
  db.transaction(() => {
    db.query(
      `DELETE FROM items WHERE (kind = 'decision' AND answered_at < ?)
         OR (kind IN ('answer', 'permission', 'permission-answer', 'settled') AND received_at < ?)
         OR (kind IN ('decision', 'quota') AND answered_at IS NULL AND received_at < ?)
         OR (kind = 'run' AND received_at < ?)`,
    ).run(answered, answered, stale, runs);
    // A waiting state goes with its decision.
    db.query(
      `DELETE FROM items WHERE kind = 'waiting' AND NOT EXISTS (SELECT 1 FROM items d
         WHERE d.account_id = items.account_id AND d.id = items.re)`,
    ).run();
    db.query(
      `DELETE FROM items WHERE kind = 'quota' AND NOT EXISTS (SELECT 1 FROM members m
         WHERE m.account_id = items.account_id AND m.id = items.from_id AND m.active = 1)`,
    ).run();
    db.query("DELETE FROM sessions WHERE expires_at < ?").run(new Date(now).toISOString());
    db.query("DELETE FROM revoked_sessions WHERE expires_at < ?").run(new Date(now).toISOString());
    db.query("DELETE FROM app_codes WHERE expires_at < ?").run(now);
  })();
}
