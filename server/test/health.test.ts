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
