import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The schema. The six migrations before launch were folded into this one when the hosted database
 * was reset, so no database that predates it is served.
 */
const V1 = `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE,
  owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Device sign-ins. member_id is set once the device's keys are in the directory.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  member_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Sessions of revoked devices, kept until they would have expired so a revoked browser hears
-- why it is signed out.
CREATE TABLE revoked_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE machine_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  member_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The signed chain, stored as received.
CREATE TABLE directory (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  seq INTEGER NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (account_id, seq)
);

-- What the server derived from the chain it verified, for routing and access checks only.
CREATE TABLE members (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  box_pk TEXT NOT NULL,
  sign_pk TEXT NOT NULL,
  active INTEGER NOT NULL,
  -- Set once the member holds a credential (a session or a machine token): each member gets
  -- credentials once, so nobody can pair an existing member's keys again to mint new ones.
  claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE pairings (
  rendezvous TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  role TEXT NOT NULL,
  member_id TEXT NOT NULL,
  box_pk TEXT NOT NULL,
  sign_pk TEXT NOT NULL,
  claim_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  account_id TEXT,
  approval TEXT,
  -- A machine's bearer token, kept until the pairing expires and is swept, so a lost reply can
  -- be retried.
  token TEXT,
  -- Why the server refused the pairing's new member, such as machine-cap, so the new machine's
  -- result poll ends at once with it instead of at the pairing's expiry (#615).
  refused TEXT
);

-- Joining by digits: a signed-in session asks to join; a device compares digits and approves.
-- version orders changes, for long-polls.
CREATE TABLE joins (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  session_hash TEXT NOT NULL,
  request TEXT NOT NULL,
  member_id TEXT NOT NULL,
  box_pk TEXT NOT NULL,
  sign_pk TEXT NOT NULL,
  commitment TEXT NOT NULL,
  approver TEXT,
  approver_key TEXT,
  joiner_key TEXT,
  approval TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL
);

-- seq orders changes: it is reassigned when an answer marks a decision answered, so a device
-- listing after its cursor sees the decision again.
CREATE TABLE items (
  seq INTEGER NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  re TEXT,
  received_at TEXT NOT NULL,
  answered_at TEXT,
  -- Bytes counted against the account's storage: its boxes, plus a charge per stored row.
  size INTEGER NOT NULL DEFAULT 0,
  -- Snoozes (#571): wake_at keeps the item's wakeAt hint as sent, which clients check against its
  -- body; wake_due is the same time in UTC while its push is still to come.
  wake_at TEXT,
  wake_due TEXT,
  -- A decision's images, each encrypted once for every device (#685): a JSON array of base64url
  -- blobs, beside its boxes.
  blobs TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX items_re ON items (account_id, re);
CREATE INDEX items_from ON items (account_id, kind, from_id);
CREATE INDEX items_wake_due ON items (wake_due) WHERE wake_due IS NOT NULL;
-- What the hourly sweep scans: items by kind and age. And a device's list with no cursor reads
-- its own account's items in order, not every account's (#585).
CREATE INDEX items_kind_received ON items (kind, received_at);
CREATE INDEX items_kind_answered ON items (kind, answered_at);
CREATE INDEX items_account_seq ON items (account_id, seq);

-- Each account's item count and stored bytes per kind, kept by the triggers below so a post
-- checks the account's caps without reading its items.
CREATE TABLE item_totals (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind)
);
CREATE TRIGGER item_totals_add AFTER INSERT ON items BEGIN
  INSERT INTO item_totals (account_id, kind, n, bytes) VALUES (new.account_id, new.kind, 1, new.size)
  ON CONFLICT (account_id, kind) DO UPDATE SET n = n + 1, bytes = bytes + excluded.bytes;
END;
CREATE TRIGGER item_totals_drop AFTER DELETE ON items BEGIN
  UPDATE item_totals SET n = n - 1, bytes = bytes - old.size
  WHERE account_id = old.account_id AND kind = old.kind;
END;

-- Never decreases, so a cursor never meets a reused seq after pruning.
CREATE TABLE item_seq (n INTEGER NOT NULL);
INSERT INTO item_seq VALUES (0);

CREATE TABLE boxes (
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  box TEXT NOT NULL,
  PRIMARY KEY (account_id, to_id, item_id),
  FOREIGN KEY (account_id, item_id) REFERENCES items(account_id, id) ON DELETE CASCADE
);
-- For the cascade from items, and for an item's recipients.
CREATE INDEX boxes_item ON boxes (account_id, item_id, to_id);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, member_id, endpoint)
);

-- The current day's usage events (server/src/usage.ts), deleted once folded into usage_days.
CREATE TABLE usage_events (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  subject TEXT,
  value REAL
);
CREATE UNIQUE INDEX usage_events_subject ON usage_events (day, metric, subject)
  WHERE subject IS NOT NULL;
-- The sweep folds and deletes events by day and metric (#585).
CREATE INDEX usage_events_day_metric ON usage_events (day, metric);

-- Counts and percentiles per day; no account or member ids.
CREATE TABLE usage_days (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (day, metric)
);
`;

/**
 * Schema changes, in order; `PRAGMA user_version` counts those a database has run. Append only:
 * a shipped migration never changes. A migration changes the schema and never rewrites rows, so
 * it runs well within the 30 s Caddy holds requests while the server restarts; a backfill runs in
 * the hourly sweep instead.
 */
const MIGRATIONS = [V1];

/** The `user_version` this server brings a database to. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  // Transactions begin IMMEDIATE, taking the write lock first, so they wait under busy_timeout
  // while another connection writes. A deferred one that reads before it writes gets SQLITE_BUSY
  // at once in WAL mode (#628).
  const transaction = db.transaction.bind(db);
  db.transaction = ((fn) => {
    const t = transaction(fn);
    return Object.assign((...args: Parameters<typeof t>) => t.immediate(...args), {
      deferred: t.deferred,
      immediate: t.immediate,
      exclusive: t.exclusive,
    });
  }) as Database["transaction"];
  migrate(db, MIGRATIONS);
  return db;
}

/**
 * Runs the migrations `db` lacks, each in its own transaction with the version it reaches. A
 * database newer than this server knows is refused, so a rolled-back server fails at start
 * rather than write rows a newer schema reads wrong.
 */
export function migrate(db: Database, migrations: readonly string[]): void {
  const { user_version: at } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (at > migrations.length) {
    db.close();
    throw new Error(
      `the database is at schema ${at}, newer than this server's ${migrations.length}: run the release that wrote it, or restore a backup`,
    );
  }
  for (let v = at; v < migrations.length; v++)
    db.transaction(() => {
      db.run(migrations[v] as string);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
}

/** The next change sequence number. Call inside a transaction. */
export function nextSeq(db: Database): number {
  const row = db.query("UPDATE item_seq SET n = n + 1 RETURNING n").get() as { n: number };
  return row.n;
}
