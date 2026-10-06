import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../src/db";

const version = (db: Database) =>
  (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

test("each migration runs once, in order", () => {
  const db = new Database(":memory:");
  const steps = ["CREATE TABLE a (x)", "ALTER TABLE a ADD COLUMN y"];
  migrate(db, steps.slice(0, 1));
  expect(version(db)).toBe(1);
  migrate(db, steps);
  migrate(db, steps);
  expect(version(db)).toBe(2);
  expect(db.query("PRAGMA table_info(a)").all().length).toBe(2);
});

test("a failed migration leaves the database at the version before it", () => {
  const db = new Database(":memory:");
  expect(() => migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (x); BROKEN"])).toThrow();
  expect(version(db)).toBe(1);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeNull();
});

test("a server refuses a database newer than its schema", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sb-db-")), "db.sqlite");
  const db = openDb(path);
  const at = version(db);
  db.run(`PRAGMA user_version = ${at + 1}`);
  db.close();
  expect(() => openDb(path)).toThrow(`schema ${at + 1}, newer`);
});

test("a database at schema 3, as the hosted one is before #571, gains the snooze columns and the sweep's indexes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sb-db-")), "db.sqlite");
  const old = openDb(path);
  for (const index of [
    "items_kind_received",
    "items_kind_answered",
    "items_account_seq",
    "usage_events_day_metric",
    "items_wake_due",
  ])
    old.run(`DROP INDEX ${index}`);
  old.run("ALTER TABLE items DROP COLUMN wake_due");
  old.run("ALTER TABLE items DROP COLUMN wake_at");
  old.run("PRAGMA user_version = 3");
  old.close();
  const db = openDb(path);
  expect(version(db)).toBe(5);
  const columns = (db.query("PRAGMA table_info(items)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(columns).toContain("wake_at");
  expect(columns).toContain("wake_due");
  expect(
    db.query("SELECT name FROM sqlite_master WHERE name = 'items_account_seq'").get(),
  ).not.toBeNull();
});

test("a write that reads first waits for another connection's write lock", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sb-db-")), "db.sqlite");
  const db = openDb(path);
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Database } from "bun:sqlite";
       const db = new Database(${JSON.stringify(path)});
       db.run("BEGIN IMMEDIATE");
       console.log("locked");
       Bun.sleepSync(300);
       db.run("ROLLBACK");`,
    ],
    { stdout: "pipe" },
  );
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
  const n = db.transaction(() => {
    const { n } = db.query("SELECT n FROM item_seq").get() as { n: number };
    db.run("UPDATE item_seq SET n = ?", [n + 1]);
    return n + 1;
  })();
  expect(n).toBe(1);
  expect(await holder.exited).toBe(0);
});
