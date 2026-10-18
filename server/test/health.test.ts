import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskHasRoom, housekeep } from "../src/app";
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
  expect((await s.app.request("/healthz")).status).toBe(200);
});

test("/healthz names the commit the server was built from", async () => {
  const built = await makeServer({ revision: "1759d0885f86369ec35c52c95b0ca81a93114457" });
  const res = await built.app.request("/healthz");
  expect(res.headers.get("x-starbridge-revision")).toBe("1759d0885f86369ec35c52c95b0ca81a93114457");
  expect(
    (await (await makeServer()).app.request("/healthz")).headers.has("x-starbridge-revision"),
  ).toBe(false);
});

test("/healthz/disk counts free blocks times their size against 2 GiB", () => {
  const GiB = 1024 ** 3;
  for (const [bavail, bsize, room] of [
    [(2 * GiB) / 4096, 4096, true],
    [(2 * GiB) / 4096 - 1, 4096, false],
    [(2 * GiB) / 512, 512, true],
    [(2 * GiB) / 512 - 1, 512, false],
    // A disk with plenty of blocks of a small size can still be nearly full.
    [3_000_000, 512, false],
    [0, 4096, false],
  ] as const)
    expect([bavail, bsize, diskHasRoom({ bavail, bsize })]).toEqual([bavail, bsize, room]);
});

test("housekeeping on a full disk waits for its next round, and any other error still throws", async () => {
  const s = await makeServer();
  const { db } = s.deps;
  const { page_count } = db.query("PRAGMA page_count").get() as { page_count: number };
  db.run(`PRAGMA max_page_count = ${page_count}`);
  const fill = db.query("INSERT INTO usage_events (day, metric, subject) VALUES ('d', 'm', ?)");
  let i = 0;
  const job = housekeep(() => {
    for (;;) fill.run(`${i++}`.padEnd(200, "x"));
  });
  // SQLite's own SQLITE_FULL, not a stand-in.
  expect(job).not.toThrow();
  expect(i).toBeGreaterThan(0);
  expect(
    housekeep(() => {
      throw new Error("no such table: pairings");
    }),
  ).toThrow("no such table: pairings");
});

test("an error the server did not expect answers 500 internal, with nothing of what failed", async () => {
  const s = await makeServer();
  s.app.get("/v1/boom", () => {
    throw new Error("secret detail");
  });
  const logged = console.error;
  console.error = () => {};
  try {
    const r = await s.call("GET", "/v1/boom");
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "internal" });
  } finally {
    console.error = logged;
  }
});
