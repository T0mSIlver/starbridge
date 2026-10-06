// Preloaded by each package's `bun test` (bunfig.toml): every temp dir a test or the process it
// spawns makes lands in one dir per run, removed when the run ends, failed or not (#313).
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "starbridge-test-"));
process.env.TMPDIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
