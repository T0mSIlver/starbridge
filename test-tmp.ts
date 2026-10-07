// Preloaded by each package's `bun test` (bunfig.toml): every temp dir a test makes lands in one
// dir per run, removed when the run ends, failed or interrupted (#313). A run killed outright
// leaves its dir behind, so each run first removes those whose process is gone (#687).
import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
for (const name of readdirSync(tmpdir())) {
  const pid = /^starbridge-test-(\d+)-/.exec(name)?.[1];
  if (pid && !alive(Number(pid))) rmSync(join(tmpdir(), name), { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), `starbridge-test-${process.pid}-`));
process.env.TMPDIR = root;
const clean = () => rmSync(root, { recursive: true, force: true });
afterAll(clean);
process.on("exit", clean);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => process.exit(130));
