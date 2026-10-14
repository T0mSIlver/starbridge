// Copies these hooks into the repository's hooks directory, which every worktree shares, so each
// worktree runs them, including worktrees on branches from before this directory existed (#1656).
// The root package.json's prepare runs it on every pnpm install outside CI.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let hooks;
try {
  const path = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: here, encoding: "utf8" });
  hooks = resolve(here, path.trim());
} catch {
  process.exit(0); // not a git checkout
}
for (const name of readdirSync(here)) {
  if (name === "install.mjs") continue;
  copyFileSync(resolve(here, name), resolve(hooks, name));
  chmodSync(resolve(hooks, name), 0o755);
}
