import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Removes `files`, paths inside `dir` that setup writes, then each folder they leave empty, `dir`
 * last. A file the owner put there stays, with its folders (#1324). Returns those files.
 */
export function removeWritten(dir: string, files: string[]): string[] {
  for (const file of files) rmSync(join(dir, file), { force: true });
  if (!existsSync(dir)) return [];
  prune(dir);
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => !e.isDirectory())
        .map((e) => join(e.parentPath, e.name))
        .sort()
    : [];
}

function prune(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true }))
    if (e.isDirectory()) prune(join(dir, e.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/** What `removeAgent` says of a folder `removeWritten` emptied, or of what it kept there. */
export function removedLine(dir: string, kept: string[]): string {
  return kept.length === 0
    ? `Removed ${dir}.`
    : `Removed Starbridge's files from ${dir}; kept ${kept.join(", ")}: setup did not write ${kept.length === 1 ? "it" : "them"}.`;
}
