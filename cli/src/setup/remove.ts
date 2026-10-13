import { existsSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The settings with `rules` taken out of `permissions.allow`, and that list and `permissions`
 * dropped when nothing else is left in them; undefined when none of `rules` was there.
 */
export function withoutAllow(
  s: { permissions?: object },
  rules: readonly string[],
): Record<string, unknown> | undefined {
  const { permissions, ...rest } = s as Record<string, unknown> & {
    permissions?: Record<string, unknown>;
  };
  const allow = permissions?.allow;
  if (!permissions || !Array.isArray(allow)) return undefined;
  const kept = allow.filter((r) => !rules.includes(r as string));
  if (kept.length === allow.length) return undefined;
  const { allow: _, ...others } = permissions;
  if (kept.length > 0) return { ...rest, permissions: { ...others, allow: kept } };
  return Object.keys(others).length > 0 ? { ...rest, permissions: others } : rest;
}

/**
 * Writes what uninstall leaves of a JSON file, or removes the file when nothing is left: setup
 * created it, and an empty file and none mean the same (#1494).
 */
export function writeLeft(path: string, value: Record<string, unknown>): void {
  if (Object.keys(value).length === 0) rmSync(path, { force: true });
  else writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
