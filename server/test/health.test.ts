import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeServer } from "../test-support/app";

test("/healthz/backup fails until a backup ran, and again once it is over 26 h old", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starbridge-"));
  const s = await makeServer({ dbPath: join(dir, "starbridge.db") });
  expect((await s.app.request("/healthz/backup")).status).toBe(503);

  const stamp = join(dir, "last-backup");
  writeFileSync(stamp, "");
  expect((await s.app.request("/healthz/backup")).status).toBe(200);

  const old = (Date.now() - 27 * 3_600_000) / 1000;
  utimesSync(stamp, old, old);
  expect((await s.app.request("/healthz/backup")).status).toBe(503);
});

test("a full database refuses writes with 503 storage-full and keeps answering reads", async () => {
  const s = await makeServer();
  const session = (await s.call("POST", "/v1/auth/owner", { body: { token: "owner-secret" } })).json
    .session;
  const { db } = s.deps;
  db.run("INSERT INTO accounts (id, created_at) VALUES ('filler', 'now')");
  const { page_count } = db.query("PRAGMA page_count").get() as { page_count: number };
  db.run(`PRAGMA max_page_count = ${page_count}`);
  // Fill the room left in the pages of the tables a sign-in and a first read write to, down to
  // the smallest row.
  const fills = [
    db.query("INSERT INTO sessions VALUES (?, 'filler', NULL, 'now', 'later')"),
    db.query("INSERT INTO usage_events (day, metric, subject) VALUES ('d', 'm', ?)"),
  ];
  let i = 0;
  for (const fill of fills)
    for (const size of [500, 50, 1])
      expect(() => {
        for (;;) fill.run(`${i++}`.padEnd(size, "x"));
      }).toThrow("full");

  // A first read today counts the caller as active: the count is dropped, the read answered.
  expect((await s.call("GET", "/v1/me", { token: session })).status).toBe(200);
  const r = await s.call("POST", "/v1/auth/owner", { body: { token: "owner-secret" } });
  expect(r.status).toBe(503);
  expect(r.json.error).toBe("storage-full");
  expect(r.headers.get("retry-after")).toBe("60");
});
