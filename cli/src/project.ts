import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * The project an item comes from: the directory's name, or for a git worktree its repository's
 * (#970). Claude Code and Codex make worktrees under generated names ("brave-dancing-lovelace"),
 * which told the owner nothing. A worktree's `.git` is a file naming
 * `<repo>/.git/worktrees/<name>`.
 */
export function projectName(cwd: string): string {
  let gitdir: string | undefined;
  try {
    gitdir = readFileSync(resolve(cwd, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  } catch {}
  if (gitdir) {
    const dir = isAbsolute(gitdir) ? gitdir : resolve(cwd, gitdir);
    const worktrees = dirname(dir);
    if (basename(worktrees) === "worktrees" && basename(dirname(worktrees)) === ".git")
      return basename(dirname(dirname(worktrees)));
  }
  return basename(cwd);
}
