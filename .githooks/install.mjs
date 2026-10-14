// Copies these hooks into the repository's hooks directory, which every worktree shares, so each
// worktree runs them, including worktrees on branches from before this directory existed (#1656).
// The root package.json's prepare runs it on every pnpm install outside CI.
//
// Every worktree's install writes to that one directory, so an install on an older branch would
// put back an older hook, as older branches did with the pre-commit fixed in #1693. Each hook
// carries a `starbridge-hook-version` line: an installed hook is replaced only by a higher
// version, or when it has no stamp or no file. Raise a hook's version whenever it changes
// (#1733). Branches from before the stamps still copy unconditionally until they merge main; the
// next install from a newer branch puts the newest back.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The hook's version stamp, 0 when it has none, -1 when there is no file. */
function version(path) {
  if (!existsSync(path)) return -1;
  const m = /^# starbridge-hook-version: (\d+)$/m.exec(readFileSync(path, "utf8"));
  return m ? Number(m[1]) : 0;
}

let hooks;
try {
  const path = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: here, encoding: "utf8" });
  hooks = resolve(here, path.trim());
} catch {
  process.exit(0); // not a git checkout
}
for (const name of readdirSync(here)) {
  if (name === "install.mjs") continue;
  const from = resolve(here, name);
  const to = resolve(hooks, name);
  if (version(from) <= version(to)) continue;
  copyFileSync(from, to);
  chmodSync(to, 0o755);
}
