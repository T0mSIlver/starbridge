import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("output into a pipe the reader closed ends quietly, with SIGPIPE's status", async () => {
  const main = join(import.meta.dir, "../src/main.ts");
  // `true` exits without reading, so every write hits a closed pipe; the CLI's status goes to
  // stderr, which stays open.
  const sh = Bun.spawn(
    ["sh", "-c", `{ "${process.execPath}" "${main}" --help; echo "exit $?" >&2; } | true`],
    {
      env: {
        ...process.env,
        STARBRIDGE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "starbridge-cli-")),
      },
      stderr: "pipe",
    },
  );
  await sh.exited;
  expect(await new Response(sh.stderr).text()).toBe("exit 141\n");
});
