/**
 * The schema side of the migration rehearsal (README.md), on SQLite files the server is not using.
 *
 *   bun schema.ts dump DB             the schema as compare reads it: user_version, then every
 *                                     table, index, view and trigger, one per line, sorted
 *   bun schema.ts load SCHEMA DB FRESH  a database from prod's schema export (SCHEMA), plus the
 *                                     rows its migrations insert, copied from FRESH, a database a
 *                                     server of the same revision made from nothing
 *
 * The export, written each night beside the offsite backup (deploy/host/offsite.sh), holds no
 * rows: `PRAGMA user_version = N;` and the CREATE statements of `sqlite3 .schema --nosys`.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";

export function dump(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
    const rows = db
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name",
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string }[];
    // Whitespace and comments differ between a statement as a migration wrote it and as the
    // sqlite3 shell prints it; nothing else may.
    const norm = (sql: string) =>
      sql
        .replace(/--[^\n]*/g, "")
        .replace(/\s+/g, " ")
        .replace(/\s*([(),])\s*/g, "$1")
        .trim();
    return [
      `user_version ${user_version}`,
      ...rows.map((r) => `${r.type} ${r.name} on ${r.tbl_name}: ${norm(r.sql)}`),
    ].join("\n");
  } finally {
    db.close();
  }
}

export function load(schemaPath: string, dbPath: string, freshPath: string): void {
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists`);
  const db = new Database(dbPath, { create: true });
  try {
    db.run(readFileSync(schemaPath, "utf8"));
    db.run(`ATTACH DATABASE '${freshPath.replaceAll("'", "''")}' AS fresh`);
    const tables = db
      .query(
        "SELECT name FROM fresh.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    for (const { name } of tables) {
      const t = `"${name.replaceAll('"', '""')}"`;
      db.run(`INSERT INTO main.${t} SELECT * FROM fresh.${t}`);
    }
    db.run("DETACH DATABASE fresh");
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "dump" && args.length === 1) console.log(dump(args[0] as string));
  else if (cmd === "load" && args.length === 3)
    load(args[0] as string, args[1] as string, args[2] as string);
  else {
    console.error("usage: schema.ts dump DB | schema.ts load SCHEMA DB FRESH");
    process.exit(2);
  }
}
