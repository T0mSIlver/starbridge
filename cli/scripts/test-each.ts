/**
 * Runs each test file in its own `bun test`, two at a time, and kills one that gives no result
 * within a few minutes: on Windows, Bun can wedge on a call over the agent's socket so that even
 * its own test timeout never fires, and the whole suite then ran until the job limit (#834). Each
 * file's output is held and printed whole when it ends, so two files never interleave. A killed
 * file is reported by name; its hung test is likely the one after the last listed in its output.
 * Exits 1 when any file failed or hung. The Windows, macOS and Linux ARM64 CI jobs run it; `bun
 * test` stays the way to run the suite.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const FILE_LIMIT_MS = 120_000;
// setup.test.ts takes about 96 s on the dev box, close to the limit on a slow runner (#1916).
const LIMIT_MS: Record<string, number> = { "setup.test.ts": 300_000 };
// Two at a time: three files are about 90% of the time (#1916), so a third worker barely helps.
const WORKERS = 2;
// The slowest first, so one worker runs them while the other drains the rest.
const SLOW = ["setup.test.ts", "permissions.test.ts", "cli.test.ts"];

const cwd = join(import.meta.dir, "..");
const files = readdirSync(join(cwd, "test"))
  .filter((f) => f.endsWith(".test.ts"))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
function rank(file: string): number {
  const i = SLOW.indexOf(file);
  return i < 0 ? SLOW.length : i;
}

async function run(file: string): Promise<string | null> {
  const limit = LIMIT_MS[file] ?? FILE_LIMIT_MS;
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, "test", "--timeout", "30000", `test/${file}`], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let hung = false;
  const watchdog = setTimeout(() => {
    hung = true;
    proc.kill("SIGKILL");
  }, limit);
  const out: string[] = [];
  const reads = Promise.all([collect(proc.stdout, out), collect(proc.stderr, out)]);
  const code = await proc.exited;
  clearTimeout(watchdog);
  // A process the test started can keep the pipes open after the file ends: print what came.
  await Promise.race([reads, Bun.sleep(5_000)]);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\n=== test/${file} (${seconds} s)\n${out.join("")}`);
  if (hung) {
    console.log(
      `::error::test/${file} hung: no result in ${limit / 1000} s, killed. The hung test is likely the one after the last listed above.`,
    );
    return `${file} (hung)`;
  }
  return code === 0 ? null : file;
}

async function collect(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) into.push(decoder.decode(chunk, { stream: true }));
}

const queue = [...files];
const failed: string[] = [];
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const failure = await run(file);
      if (failure) failed.push(failure);
    }
  }),
);
if (failed.length) {
  console.log(`Failed: ${failed.join(", ")}`);
  process.exit(1);
}
// A file's leftover process can hold a pipe open; it must not keep the suite running.
process.exit(0);
