/**
 * Runs each test file in its own `bun test`, and kills one that gives no result within a few
 * minutes: on Windows, Bun can wedge on a call over the agent's socket so that even its own test
 * timeout never fires, and the whole suite then ran until the job limit (#834). A killed file is
 * reported by name; its hung test is likely the one after the last listed above it. Exits 1 when any
 * file failed or hung. The Windows CI job runs it; `bun test` stays the way to run the suite.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const FILE_LIMIT_MS = 180_000;

const files = readdirSync(join(import.meta.dir, "../test"))
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
const failed: string[] = [];
for (const file of files) {
  const proc = Bun.spawn([process.execPath, "test", "--timeout", "30000", `test/${file}`], {
    cwd: join(import.meta.dir, ".."),
    stdio: ["ignore", "inherit", "inherit"],
  });
  let hung = false;
  const watchdog = setTimeout(() => {
    hung = true;
    proc.kill("SIGKILL");
  }, FILE_LIMIT_MS);
  const code = await proc.exited;
  clearTimeout(watchdog);
  if (hung) {
    console.log(
      `::error::test/${file} hung: no result in ${FILE_LIMIT_MS / 1000} s, killed. The hung test is likely the one after the last listed above.`,
    );
    failed.push(`${file} (hung)`);
  } else if (code !== 0) failed.push(file);
}
if (failed.length) {
  console.log(`Failed: ${failed.join(", ")}`);
  process.exit(1);
}
