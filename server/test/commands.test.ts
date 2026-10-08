import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `bun server.js ARGS` against a fresh database file, as deploy/host/switch.sh does. */
function command(...args: string[]) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "starbridge-cmd-")), "starbridge.db");
  const proc = Bun.spawnSync([process.execPath, "src/main.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, DB_PATH: dbPath },
  });
  return { code: proc.exitCode, out: proc.stdout.toString() };
}

// A command that falls through would start a second server, or fail as unknown after it printed.
test("each server command prints and exits 0; an unknown one exits 2", () => {
  for (const args of [["schema"], ["usage", "1"], ["signups", "status"], ["limits", "show"]])
    expect(command(...args).code).toBe(0);
  const top = command("top", "3", "--json");
  expect(top.code).toBe(0);
  expect(JSON.parse(top.out)).toMatchObject({ accounts: 0 });
  expect(command("nonsense").code).toBe(2);
});
