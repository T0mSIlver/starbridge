import type { Database } from "bun:sqlite";
import { ITEM_KINDS, ItemKind, type Keep, type RetentionPeriod } from "@starbridge/protocol";
import type { Limits } from "./limits";

const PERIODS = {
  day: "runRetention",
  week: "answeredRetention",
  month: "staleRetention",
} as const satisfies Record<RetentionPeriod, keyof Limits>;

/** Rows each delete takes at once; the server answers requests between batches (#585). */
const BATCH = 1000;

/** Runs `DELETE FROM items WHERE <where>` a batch at a time, yielding to requests between. */
async function deleteItems(
  db: Database,
  where: string,
  params: string[],
  batch: number,
): Promise<void> {
  const del = db.query(
    `DELETE FROM items WHERE rowid IN (SELECT rowid FROM items WHERE ${where} LIMIT ${batch})`,
  );
  // Until a batch finds nothing: `changes` counts the boxes each item takes with it too.
  while (del.run(...params).changes > 0) await new Promise((r) => setImmediate(r));
}

/**
 * Deletes items matching `where` that an index cannot narrow (a NOT EXISTS check), walking the
 * table once by rowid: each batch starts past the last one, so the rows kept are checked once a
 * sweep rather than once a batch. `where` must not let the planner pick an index over the rowid
 * walk; prefix an indexed column with `+`.
 */
async function deleteOrphans(
  db: Database,
  where: string,
  params: string[],
  batch: number,
): Promise<void> {
  const next = db.query(
    `SELECT rowid AS r FROM items WHERE rowid > ? AND ${where} ORDER BY rowid LIMIT ${batch}`,
  );
  // Checks `where` again, so a row that changed since `next` read it stays.
  const del = db.query(`DELETE FROM items WHERE rowid > ? AND rowid <= ? AND ${where}`);
  for (let after = 0; ; ) {
    const rows = next.all(after, ...params) as { r: number }[];
    const last = rows.at(-1)?.r;
    if (last === undefined) return;
    del.run(after, last, ...params);
    if (rows.length < batch) return;
    after = last;
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * Drops what no client needs any more: each kind's items as its `keep` in `ITEM_KINDS` says,
 * expired sessions and expired app sign-in codes. Boxes go with their items.
 */
export async function sweepStorage(
  db: Database,
  limits: Limits,
  now = Date.now(),
  batch = BATCH,
): Promise<void> {
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
  if (aged.length > 0) await deleteItems(db, aged.join(" OR "), params, batch);
  await deleteOrphans(
    db,
    `+kind IN (${marks(fromActive)}) AND NOT EXISTS (SELECT 1 FROM members m
       WHERE m.account_id = items.account_id AND m.id = items.from_id AND m.active = 1)`,
    fromActive,
    batch,
  );
  // Last, so an item goes in the same sweep as the one it refers to. Between batches a list
  // may show a waiting or snoozed item for a moment after its decision is gone.
  await deleteOrphans(
    db,
    `+kind IN (${marks(withRe)}) AND NOT EXISTS (SELECT 1 FROM items d
       WHERE d.account_id = items.account_id AND d.id = items.re)`,
    withRe,
    batch,
  );
  db.transaction(() => {
    db.query("DELETE FROM sessions WHERE expires_at < ?").run(new Date(now).toISOString());
    db.query("DELETE FROM revoked_sessions WHERE expires_at < ?").run(new Date(now).toISOString());
    // Nothing writes app_codes since #527; this clears the codes issued before it.
    db.query("DELETE FROM app_codes WHERE expires_at < ?").run(now);
  })();
}
