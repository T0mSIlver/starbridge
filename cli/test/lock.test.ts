import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config";

const folder = () => mkdtempSync(join(tmpdir(), "starbridge-lock-"));
const TAKE = join(import.meta.dir, "fixtures/lock-take.ts");

test("a lock that has named no process for a minute is broken (#2298)", () => {
  for (const text of ["", "4"]) {
    const dir = folder();
    writeFileSync(join(dir, ".lock"), text);
    const before = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock"), before, before);
    expect(new Store(dir).locked(() => "ran")).toBe("ran");
    expect(readdirSync(dir)).toEqual([]);
  }
});

test("a lock just created, whose process has not named itself yet, is waited for (#2298)", async () => {
  const dir = folder();
  const lock = join(dir, ".lock");
  writeFileSync(lock, "");
  const other = Bun.spawn([process.execPath, TAKE, dir], { stdout: "pipe", stderr: "inherit" });
  const said = other.stdout.getReader();
  const say = async () => new TextDecoder().decode((await said.read()).value);
  expect(await say()).toBe("waiting\n");
  await Bun.sleep(300);
  expect(readFileSync(lock, "utf8")).toBe("");
  writeFileSync(lock, `${process.pid} a-live-holder`);
  await Bun.sleep(100);
  expect(readFileSync(lock, "utf8")).toBe(`${process.pid} a-live-holder`);
  rmSync(lock);
  expect(await say()).toBe("ran\n");
  expect(await other.exited).toBe(0);
});

// Windows has no file size limit to set, and no other way to fail a write after its create.
test.skipIf(process.platform === "win32")(
  "a lock that could not be written is not left behind (#2298)",
  async () => {
    const dir = folder();
    // No file may grow past 0 bytes: the lock is created, and writing the holder into it fails.
    const full = Bun.spawn(
      ["sh", "-c", `trap '' XFSZ; ulimit -f 0; exec "$0" "$1" "$2"`, process.execPath, TAKE, dir],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await full.exited).not.toBe(0);
    expect(await new Response(full.stdout).text()).toBe("waiting\n");
    expect(readdirSync(dir)).toEqual([]);
  },
);
