import type { Database } from "bun:sqlite";
import { ITEM_KINDS, ItemKind, type Keep, type RetentionPeriod } from "@starbridge/protocol";
import type { Limits } from "./limits";

const PERIODS = {
  day: "runRetention",
  week: "answeredRetention",
  month: "staleRetention",
} as const satisfies Record<RetentionPeriod, keyof Limits>;

/**
 * Drops what no client needs any more: each kind's items as its `keep` in `ITEM_KINDS` says,
 * expired sessions and expired app sign-in codes. Boxes go with their items.
 */
export function sweepStorage(db: Database, limits: Limits, now = Date.now()): void {
  const before = (period: RetentionPeriod) => new Date(now - limits[PERIODS[period]]).toISOString();
  const aged: string[] = [];
  const params: string[] = [];
  const rule = (sql: string, kind: string, period: RetentionPeriod) => {
    aged.push(`(kind = ? AND ${sql})`);
    params.push(kind, before(period));
  };
  for (const kind of ItemKind.options) {
    const keep: Keep = ITEM_KINDS[kind].keep;
    if (keep.received) rule("received_at < ?", kind, keep.received);
    if (keep.answered) rule("answered_at < ?", kind, keep.answered);
    if (keep.unanswered) rule("answered_at IS NULL AND received_at < ?", kind, keep.unanswered);
  }
  const kinds = (flag: "withRe" | "fromActive") =>
    ItemKind.options.filter((k) => (ITEM_KINDS[k].keep as Keep)[flag]);
  const marks = (list: string[]) => list.map(() => "?").join(", ");
  const withRe = kinds("withRe");
  const fromActive = kinds("fromActive");
  db.transaction(() => {
    if (aged.length > 0) db.query(`DELETE FROM items WHERE ${aged.join(" OR ")}`).run(...params);
    db.query(
      `DELETE FROM items WHERE kind IN (${marks(fromActive)}) AND NOT EXISTS (SELECT 1 FROM members m
         WHERE m.account_id = items.account_id AND m.id = items.from_id AND m.active = 1)`,
    ).run(...fromActive);
    // Last, so an item goes in the same sweep as the one it refers to.
    db.query(
      `DELETE FROM items WHERE kind IN (${marks(withRe)}) AND NOT EXISTS (SELECT 1 FROM items d
         WHERE d.account_id = items.account_id AND d.id = items.re)`,
    ).run(...withRe);
    db.query("DELETE FROM sessions WHERE expires_at < ?").run(new Date(now).toISOString());
    db.query("DELETE FROM revoked_sessions WHERE expires_at < ?").run(new Date(now).toISOString());
    // Nothing writes app_codes since #527; this clears the codes issued before it.
    db.query("DELETE FROM app_codes WHERE expires_at < ?").run(now);
  })();
}
