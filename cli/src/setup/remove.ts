import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { replaceFile } from "../replace";

/**
 * Removes `files`, paths inside `dir` that setup writes, then each folder they leave empty, `dir`
 * last, then its parents up to `root` (`pruneEmpty`). A file the owner put there stays, with its
 * folders (#1324). Returns those files.
 */
export function removeWritten(dir: string, files: string[], root?: string): string[] {
  for (const file of files) if (stays(dir, file)) rmSync(join(dir, file), { force: true });
  if (!existsSync(dir)) {
    if (root) pruneEmpty(dirname(dir), root);
    return [];
  }
  prune(dir);
  if (root) pruneEmpty(dirname(dir), root);
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => !e.isDirectory())
        .map((e) => join(e.parentPath, e.name))
        .sort()
    : [];
}

/** Whether `file`'s folder, once symlinks are followed, is still inside `dir`: a link the owner made stays unfollowed. */
function stays(dir: string, file: string): boolean {
  try {
    const real = realpathSync(dirname(join(dir, file)));
    const rel = relative(realpathSync(dir), real);
    return !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return true;
  }
}

/**
 * Removes `dir`, then each parent, while it is empty and inside `root`, which stays: the folders
 * setup made for its files in an agent's folder, such as `~/.codex/skills` (#2098).
 */
export function pruneEmpty(dir: string, root: string): void {
  for (let d = dir; ; d = dirname(d)) {
    const rel = relative(root, d);
    if (rel === "" || rel.startsWith("..") || dirname(d) === d) return;
    try {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
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

/**
 * The settings with `rules` taken out of `permissions.allow`, and that list and `permissions`
 * dropped when nothing else is left in them; undefined when none of `rules` was there.
 */
export function withoutAllow(
  s: { permissions?: object },
  rules: readonly string[],
): Record<string, unknown> | undefined {
  const { permissions } = s as { permissions?: Record<string, unknown> };
  const allow = permissions?.allow;
  if (!permissions || !Array.isArray(allow)) return undefined;
  const kept = allow.filter((r) => !rules.includes(r as string));
  if (kept.length === allow.length) return undefined;
  const { allow: _, ...others } = permissions;
  const left =
    kept.length > 0
      ? Object.fromEntries(
          Object.entries(permissions).map(([k, v]) => [k, k === "allow" ? kept : v]),
        )
      : others;
  // The owner's keys stay in their order (#2098).
  return Object.fromEntries(
    Object.entries(s).flatMap(([k, v]) =>
      k !== "permissions" ? [[k, v]] : Object.keys(left).length > 0 ? [[k, left]] : [],
    ),
  );
}

/**
 * Writes what uninstall leaves of a JSON file, or removes the file when nothing is left: setup
 * created it, and an empty file and none mean the same (#1494).
 */
export function writeLeft(path: string, value: Record<string, unknown>): void {
  if (Object.keys(value).length === 0) rmSync(path, { force: true });
  else replaceFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
