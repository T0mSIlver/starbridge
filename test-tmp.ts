// Preloaded by each package's `bun test` (bunfig.toml): every temp dir a test makes lands in one
// dir per run, removed when the run ends, failed or interrupted (#313).
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "starbridge-test-"));
process.env.TMPDIR = root;
const clean = () => rmSync(root, { recursive: true, force: true });
afterAll(clean);
process.on("exit", clean);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => process.exit(130));
