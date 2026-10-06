import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { paired } from "./helpers";

// npm ships the bundle `bun run build` makes, which runs under Node: Bun's globals are not there.
let server: LiveServer;
let bundle: string;
beforeAll(async () => {
  server = await LiveServer.start();
  bundle = join(mkdtempSync(join(tmpdir(), "sb-npm-")), "starbridge.js");
  const built = Bun.spawnSync([
    process.execPath,
    "build",
    join(import.meta.dir, "../src/main.ts"),
    "--target",
    "node",
    "--outfile",
    bundle,
  ]);
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
});
afterAll(() => server.stop());

test("the npm bundle asks from a Codex session under Node", async () => {
  const ctx = await paired(server);
  const bin = mkdtempSync(join(tmpdir(), "sb-bin-"));
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "codex"), 0o755);
  const home = mkdtempSync(join(tmpdir(), "sb-home-"));
  mkdirSync(join(home, ".codex"));
  // Async: the server answering it runs in this process.
  const r = Bun.spawn(
    [
      "node",
      bundle,
      "ask",
      "--question",
      "Merge #12 now?",
      "--option",
      "Merge",
      "--option",
      "Wait",
    ],
    {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        STARBRIDGE_CONFIG_DIR: ctx.store.dir,
        STARBRIDGE_NO_AGENT: "1",
        CODEX_THREAD_ID: "t1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([
    r.exited,
    new Response(r.stdout).text(),
    new Response(r.stderr).text(),
  ]);
  expect(err).not.toContain("is not defined");
  expect(code).toBe(0);
  expect(out).toMatch(/^d_/);
});
