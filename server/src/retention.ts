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
/**
 * Stored bytes each delete takes at once, at least one item: a thousand 2 MB questions would
 * otherwise go in one transaction, holding the write lock and growing the WAL by 2 GB (#1736).
 */
const BATCH_BYTES = 32 * 1024 * 1024;

/** Batch limits: rows and stored bytes. */
type Batch = { rows: number; bytes: number };

/** The leading rows of `rows` whose sizes fit `bytes`, at least one. */
function fitting<T extends { size: number }>(rows: T[], bytes: number): T[] {
  let total = 0;
  let n = 0;
  for (const r of rows) {
    total += r.size;
    if (n > 0 && total > bytes) break;
    n += 1;
  }
  return rows.slice(0, n);
}

const pause = () => new Promise((r) => setImmediate(r));

/** Runs `DELETE FROM items WHERE <where>` a batch at a time, yielding to requests between. */
async function deleteItems(
  db: Database,
  where: string,
  params: string[],
  batch: Batch,
): Promise<void> {
  const next = db.query(`SELECT rowid AS r, size FROM items WHERE ${where} LIMIT ${batch.rows}`);
  const del = db.query(
    `DELETE FROM items WHERE rowid IN (SELECT value FROM json_each(?)) AND (${where})`,
  );
  // Until a batch finds nothing.
  for (;;) {
    const rows = fitting(next.all(...params) as { r: number; size: number }[], batch.bytes);
    if (rows.length === 0) return;
    del.run(JSON.stringify(rows.map((x) => x.r)), ...params);
    await pause();
  }
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
  batch: Batch,
): Promise<void> {
  const next = db.query(
    `SELECT rowid AS r, size FROM items WHERE rowid > ? AND (${where}) ORDER BY rowid LIMIT ${batch.rows}`,
  );
  // Checks `where` again, so a row that changed since `next` read it stays.
  const del = db.query(`DELETE FROM items WHERE rowid > ? AND rowid <= ? AND (${where})`);
  for (let after = 0; ; ) {
    const found = next.all(after, ...params) as { r: number; size: number }[];
    const rows = fitting(found, batch.bytes);
    const last = rows.at(-1)?.r;
    if (last === undefined) return;
    del.run(after, last, ...params);
    if (found.length < batch.rows && rows.length === found.length) return;
    after = last;
    await pause();
  }
}

/** Stored bytes of every account's items together, as the server-wide cap counts them. */
function serverBytes(db: Database): number {
  return (
    db.query("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM item_totals").get() as {
      bytes: number;
    }
  ).bytes;
}

/**
 * Deletes every item of `account`, a batch at a time, for `bun server.js purge` (#1736); the
 * account, its devices and machines stay. Returns the stored bytes freed.
 */
export async function purgeAccount(
  db: Database,
  account: string,
  batch: Batch = { rows: BATCH, bytes: BATCH_BYTES },
): Promise<number> {
  const before = serverBytes(db);
  await deleteItems(db, "account_id = ?", [account], batch);
  return before - serverBytes(db);
}

/**
 * Drops what no client needs any more: each kind's items as its `keep` in `ITEM_KINDS` says,
 * expired sessions and expired app sign-in codes. Boxes go with their items.
 */
export async function sweepStorage(
  db: Database,
  limits: Limits,
  now = Date.now(),
  rows = BATCH,
  bytes = BATCH_BYTES,
): Promise<void> {
  const batch = { rows, bytes };
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
  // A flooded account's unanswered decisions go after floodRetention instead (#584).
  const flooded = db
    .query(
      `SELECT account_id AS a FROM items WHERE kind = 'decision' AND answered_at IS NULL
       GROUP BY account_id HAVING COUNT(*) > ?`,
    )
    .all(limits.floodUnanswered) as { a: string }[];
  const floodBefore = new Date(now - limits.floodRetention).toISOString();
  const shorten = (account: string) =>
    deleteItems(
      db,
      "kind = 'decision' AND answered_at IS NULL AND received_at < ? AND account_id = ?",
      [floodBefore, account],
      batch,
    );
  for (const { a } of flooded) await shorten(a);
  // A server near its serverBytes refuses every machine's items (#1736). The accounts holding the
  // most keep their unanswered decisions only floodRetention too, the largest first, until the
  // server is back under 90% of it: a few accounts at their cap fill it, which would otherwise
  // last the 30 days unanswered decisions are kept.
  const roomy = limits.serverBytes * 0.9;
  if (serverBytes(db) > roomy) {
    const holders = db
      .query(
        `SELECT account_id AS a FROM item_totals GROUP BY account_id
         ORDER BY SUM(bytes) DESC LIMIT 100`,
      )
      .all() as { a: string }[];
    for (const { a } of holders) {
      if (serverBytes(db) <= roomy) break;
      await shorten(a);
    }
  }
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
  })();
}
