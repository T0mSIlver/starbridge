import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, openDb } from "../src/db";
import { OLD_MIGRATIONS } from "./fixtures/migrations-v1-v6";

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

/** Every table's and index's definition, comments and whitespace aside, with its columns and indexes. */
function schema(db: Database) {
  const rows = db
    .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  // ALTER TABLE leaves a dropped column's comment and puts an added column after the last one's
  // text, so comments and spacing are not part of the schema.
  const sql = (s: string | null) =>
    s
      ?.replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .replace(/ ?([(),]) ?/g, "$1")
      .trim() ?? null;
  return rows.map((r) => ({
    ...r,
    sql: sql(r.sql),
    ...(r.type === "table" && {
      columns: db.query(`PRAGMA table_info(${r.name})`).all(),
      indexes: db.query(`PRAGMA index_list(${r.name})`).all(),
    }),
  }));
}

test("the folded schema is the one migrations 1 to 6 built, without app_codes", () => {
  const old = new Database(":memory:");
  migrate(old, OLD_MIGRATIONS);
  // Unused since #527, left out of the fold.
  old.run("DROP TABLE app_codes");
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS.slice(0, 1));
  expect(version(db)).toBe(1);
  expect(schema(db).length).toBeGreaterThan(20);
  expect(schema(db)).toEqual(schema(old));
});

test("V2 adds suspended_at to the accounts of a V1 database, none suspended (#785)", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sb-db-")), "db.sqlite");
  const v1 = new Database(path);
  migrate(v1, MIGRATIONS.slice(0, 1));
  v1.run(
    "INSERT INTO accounts (id, github_id, created_at) VALUES ('a1', 1, '2026-10-08T00:00:00Z')",
  );
  v1.close();
  const db = openDb(path);
  expect(version(db)).toBe(2);
  expect(db.query("SELECT id, suspended_at FROM accounts").all()).toEqual([
    { id: "a1", suspended_at: null },
  ]);
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
