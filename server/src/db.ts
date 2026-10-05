import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE,
  owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Device sign-ins. member_id is set once the device's keys are in the directory.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  member_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Sessions of revoked devices, kept until they would have expired so a revoked browser hears
-- why it is signed out.
CREATE TABLE IF NOT EXISTS revoked_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

-- App sign-in codes waiting to be traded for a session; challenge is the S256 PKCE challenge.
CREATE TABLE IF NOT EXISTS app_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machine_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  member_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The signed chain, stored as received.
CREATE TABLE IF NOT EXISTS directory (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  seq INTEGER NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (account_id, seq)
);

-- What the server derived from the chain it verified, for routing and access checks only.
CREATE TABLE IF NOT EXISTS members (
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

CREATE TABLE IF NOT EXISTS pairings (
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
  token TEXT
);

-- Joining by digits: a signed-in session asks to join; a device compares digits and approves.
-- version orders changes, for long-polls.
CREATE TABLE IF NOT EXISTS joins (
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
CREATE TABLE IF NOT EXISTS items (
  seq INTEGER NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  re TEXT,
  received_at TEXT NOT NULL,
  answered_at TEXT,
  -- Bytes of the item's boxes, counted against the account's storage.
  size INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);

-- Never decreases, so a cursor never meets a reused seq after pruning.
CREATE TABLE IF NOT EXISTS item_seq (n INTEGER NOT NULL);
INSERT INTO item_seq SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM item_seq);

CREATE TABLE IF NOT EXISTS boxes (
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  box TEXT NOT NULL,
  PRIMARY KEY (account_id, to_id, item_id),
  FOREIGN KEY (account_id, item_id) REFERENCES items(account_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
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
CREATE TABLE IF NOT EXISTS usage_events (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  subject TEXT,
  value REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_subject ON usage_events (day, metric, subject)
  WHERE subject IS NOT NULL;

-- Counts and percentiles per day; no account or member ids.
CREATE TABLE IF NOT EXISTS usage_days (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (day, metric)
);
`;

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA);
  // Databases made before items had a size; their old items count as empty until swept.
  const columns = db.query("PRAGMA table_info(items)").all() as { name: string }[];
  if (!columns.some((col) => col.name === "size"))
    db.run("ALTER TABLE items ADD COLUMN size INTEGER NOT NULL DEFAULT 0");
  return db;
}

/** The next change sequence number. Call inside a transaction. */
export function nextSeq(db: Database): number {
  const row = db.query("UPDATE item_seq SET n = n + 1 RETURNING n").get() as { n: number };
  return row.n;
}
