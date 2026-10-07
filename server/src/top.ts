import type { Database } from "bun:sqlite";

export interface AccountRow {
  account: string;
  createdAt: string;
  items: number;
  bytes: number;
  postsLastHour: number;
  machines: number;
  devices: number;
}

/**
 * The accounts that hold or post the most, and sign-ups and pairings in the last hour, for the
 * launch watcher (#782). Read-only. Posts count items received in the last hour; an item that
 * replaced an earlier one (a quota snapshot, a run) counts once.
 */
export function top(db: Database, n: number, now = Date.now()) {
  const hourAgo = new Date(now - 3_600_000).toISOString();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const count = (sql: string, ...args: string[]) => (db.query(sql).get(...args) as { n: number }).n;
  const rows = (order: string) =>
    db
      .query(
        `SELECT a.id AS account, a.created_at AS createdAt,
           COALESCE((SELECT SUM(n) FROM item_totals t WHERE t.account_id = a.id), 0) AS items,
           COALESCE((SELECT SUM(bytes) FROM item_totals t WHERE t.account_id = a.id), 0) AS bytes,
           (SELECT COUNT(*) FROM items i WHERE i.account_id = a.id AND i.received_at >= ?) AS postsLastHour,
           (SELECT COUNT(*) FROM members m WHERE m.account_id = a.id AND m.active = 1 AND m.role = 'machine') AS machines,
           (SELECT COUNT(*) FROM members m WHERE m.account_id = a.id AND m.active = 1 AND m.role = 'device') AS devices
         FROM accounts a ORDER BY ${order} DESC LIMIT ?`,
      )
      .all(hourAgo, n) as AccountRow[];
  const nonzero = (key: keyof AccountRow) => (r: AccountRow) => (r[key] as number) > 0;
  return {
    at: new Date(now).toISOString(),
    accounts: count("SELECT COUNT(*) AS n FROM accounts"),
    signUpsLastHour: count("SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?", hourAgo),
    signUpsLastDay: count("SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?", dayAgo),
    signInsLastHour: count("SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ?", hourAgo),
    machinesPairedLastHour: count(
      "SELECT COUNT(*) AS n FROM machine_tokens WHERE created_at >= ?",
      hourAgo,
    ),
    pendingPairings: count("SELECT COUNT(*) AS n FROM pairings WHERE approval IS NULL"),
    byItems: rows("items").filter(nonzero("items")),
    byBytes: rows("bytes").filter(nonzero("bytes")),
    byPostsLastHour: rows("postsLastHour").filter(nonzero("postsLastHour")),
  };
}

/** The same as a few lines of text, for a person at the box. */
export function formatTop(t: ReturnType<typeof top>): string {
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  const list = (title: string, rs: AccountRow[]) => [
    `${title}:`,
    ...(rs.length === 0
      ? ["  none"]
      : rs.map(
          (r) =>
            `  ${r.account}  ${r.items} items, ${mb(r.bytes)}, ${r.postsLastHour} posts last hour, ${r.machines} machines, ${r.devices} devices, since ${r.createdAt.slice(0, 16)}`,
        )),
  ];
  return [
    `${t.accounts} accounts; last hour: ${t.signUpsLastHour} sign-ups, ${t.signInsLastHour} sign-ins, ${t.machinesPairedLastHour} machines paired; ${t.signUpsLastDay} sign-ups in 24 h; ${t.pendingPairings} pairings waiting`,
    ...list("Most items", t.byItems),
    ...list("Most bytes", t.byBytes),
    ...list("Most posts in the last hour", t.byPostsLastHour),
  ].join("\n");
}
