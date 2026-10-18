import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const script = join(root, "deploy/host/keep-logs.sh");

test("a deploy deletes the failed-deploy logs older than 2 days and keeps newer ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "keep-logs-"));
  const day = 86400;
  const now = Date.now() / 1000;
  writeFileSync(join(dir, "server-old.log"), "x");
  utimesSync(join(dir, "server-old.log"), now - 3 * day, now - 3 * day);
  writeFileSync(join(dir, "server-new.log"), "x");
  utimesSync(join(dir, "server-new.log"), now - 1 * day, now - 1 * day);
  const r = spawnSync("sh", [script, "--prune"], {
    env: { ...process.env, KEEP_LOGS_DIR: dir },
  });
  expect(r.status).toBe(0);
  expect(readdirSync(dir)).toEqual(["server-new.log"]);
});

test("a failed service's logs go to a file only the operator reads, and only its path is printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "keep-logs-"));
  const r = spawnSync("sh", [script, "web", "echo", "secret-log-line"], {
    env: { ...process.env, KEEP_LOGS_DIR: dir, DEPLOY_LOGS: "" },
    encoding: "utf8",
  });
  expect(r.stdout + r.stderr).not.toContain("secret-log-line");
  const file = readdirSync(dir)[0] ?? "";
  expect(readFileSync(join(dir, file), "utf8")).toContain("secret-log-line");
});

test("apply.sh prunes the logs on every deploy, and /privacy states the 2 days", () => {
  expect(readFileSync(join(root, "deploy/host/apply.sh"), "utf8")).toContain(
    "host/keep-logs.sh --prune",
  );
  const page = readFileSync(join(root, "web/src/app/privacy/page.tsx"), "utf8");
  expect(page).toMatch(/deleted after 2 days/);
});
