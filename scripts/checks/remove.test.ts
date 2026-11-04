// Setup and uninstall deleted whole Starbridge folders, the owner's own files inside included:
// #1324, then #2160 in starbridge-remote after the install walk was in place. Starbridge shares
// its folders in an agent's config with the owner, so it removes only the files it wrote
// (`removeWritten`). This fails on a recursive delete that does not say why it may take a whole
// folder.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const DIRS = ["cli/src", "cli/install.sh", "mod", "plugin"];
// End-to-end runs delete their own scratch folders; tests and dependencies are not shipped.
const SKIP = /(^|\/)(node_modules|test|e2e)(\/|$)/;
const SOURCE = /\.(ts|js|sh)$/;

function files(path: string): string[] {
  if (SKIP.test(path)) return [];
  if (!statSync(join(root, path)).isDirectory()) return SOURCE.test(path) ? [path] : [];
  return readdirSync(join(root, path)).flatMap((name) => files(`${path}/${name}`));
}

const CALL = /\b(rmSync|rmdirSync|rm|rmdir)\(/;
const SHELL = /\brm\s+-[a-zA-Z]*[rR]/;

/**
 * Lines that start a recursive delete. A call's options may sit on the lines after it, so a call
 * is read up to its closing parenthesis. `remove-ok: <why>` on the line or the one before exempts
 * it.
 */
export function offenders(text: string, path: string): string[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return [];
    if (/remove-ok:/.test(line) || /remove-ok:/.test(lines[i - 1] ?? "")) return [];
    let recursive = false;
    if (path.endsWith(".sh")) recursive = SHELL.test(line);
    else if (CALL.test(line)) {
      let call = line.slice(line.search(CALL));
      for (let j = i + 1; j < lines.length && j < i + 6 && !balanced(call); j++)
        call += lines[j];
      recursive = /recursive:\s*true/.test(call);
    }
    return recursive ? [`${path}:${i + 1}: ${line.trim()}`] : [];
  });
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return true;
  }
  return false;
}

test("a recursive delete says why it may take the whole folder (#1324, #2160)", () => {
  const found = DIRS.flatMap(files).flatMap((path) =>
    offenders(readFileSync(join(root, path), "utf8"), path),
  );
  expect(
    found,
    "Use removeWritten(dir, files) from cli/src/setup/remove.ts: a recursive delete also takes the owner's files in that folder (#1324, #2160). A folder only Starbridge writes, such as its own temp folder, may go whole: say so with `remove-ok: <why>` on the line or the one before",
  ).toEqual([]);
});

test("the check catches #2160's recursive delete, its options on the next line, and rm -rf", () => {
  expect(offenders("  rmSync(dir, { recursive: true, force: true });", "a.ts")).toHaveLength(1);
  expect(offenders("rmSync(dir, {\n  recursive: true,\n});", "a.ts")).toHaveLength(1);
  expect(offenders('rm -rf "$dir"', "a.sh")).toHaveLength(1);
  expect(offenders("rmSync(file, { force: true });", "a.ts")).toEqual([]);
  expect(
    offenders("// remove-ok: our own temp folder\nrmSync(tmp, { recursive: true });", "a.ts"),
  ).toEqual([]);
});
