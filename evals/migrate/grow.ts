/**
 * Grows a database fill.ts filled until its file reaches `--mb`: copies of every item and its
 * boxes, under new ids and change numbers, in the same accounts. The server must be stopped. The
 * copies go through the schema's own triggers, so the per-account totals stay true; the
 * columns come from the database, so this works on any revision's schema.
 *
 *   bun evals/migrate/grow.ts DB --mb 2048
 */
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { mb: { type: "string", default: "2048" } },
});
const path = positionals[0];
if (!path) throw new Error("usage: grow.ts DB --mb N");
const want = Number(values.mb) * 1024 * 1024;
const db = new Database(path);
db.run("PRAGMA journal_mode = WAL");
const size = () => {
  const { n } = db
    .query("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()")
    .get() as {
    n: number;
  };
  return n;
};
const cols = (table: string) =>
  (db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(
    (c) => c.name,
  );
const items = cols("items");
const boxes = cols("boxes");
// Copy k of item id X is X~k; ids never hold "~" otherwise.
const pick = (list: string[], over: Record<string, string>) =>
  list.map((c) => over[c] ?? `"${c}"`).join(", ");
const { originals, top } = db
  .query("SELECT count(*) AS originals, coalesce(max(seq), 0) AS top FROM items")
  .get() as { originals: number; top: number };
if (!originals) throw new Error("no items to copy: run fill.ts first");
const copy = db.transaction((k: number) => {
  db.run(
    `INSERT INTO items (${items.map((c) => `"${c}"`).join(", ")})
     SELECT ${pick(items, { id: `id || '~${k}'`, seq: `seq + ${k * top}` })} FROM items WHERE instr(id, '~') = 0`,
  );
  db.run(
    `INSERT INTO boxes (${boxes.map((c) => `"${c}"`).join(", ")})
     SELECT ${pick(boxes, { item_id: `item_id || '~${k}'` })} FROM boxes WHERE instr(item_id, '~') = 0`,
  );
  // An answer's copy refers to its decision's copy.
  if (items.includes("re"))
    db.run(`UPDATE items SET re = re || '~${k}' WHERE id LIKE '%~${k}' AND re IS NOT NULL`);
});
let k = 0;
const started = Date.now();
while (size() < want) {
  copy(++k);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  console.log(
    `copy ${k}: ${(size() / 1048576).toFixed(0)} MB (${((Date.now() - started) / 1000).toFixed(0)} s)`,
  );
}
db.run("UPDATE item_seq SET n = (SELECT max(seq) FROM items)");
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
const { n } = db.query("SELECT count(*) AS n FROM items").get() as { n: number };
console.log(`${n} items, ${(size() / 1048576).toFixed(0)} MB`);
db.close();
