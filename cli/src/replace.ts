import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse } from "node:path";

/** `rel` from the real folder `from`, each step through the file system, as the OS walks a path. */
function walk(from: string, rel: string): string {
  let at = isAbsolute(rel) ? parse(rel).root : from;
  for (const step of rel.split(/[\\/]+/)) {
    if (step === "" || step === ".") continue;
    // `at` is real, so its parent is the folder above it.
    if (step === "..") at = dirname(at);
    else {
      at = join(at, step);
      try {
        at = realpathSync(at);
      } catch {}
    }
  }
  return at;
}

/**
 * Where `path` leads through its symbolic links, followed even to a file not there yet; `..` after
 * a linked folder goes above the link's target, as the OS reads it.
 */
function linked(path: string): string {
  try {
    return realpathSync(path);
  } catch {}
  let p = path;
  for (let i = 0; i < 40; i++) {
    let link: boolean;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch {
      return p;
    }
    if (!link) return p;
    let from: string;
    try {
      from = realpathSync(dirname(p));
    } catch {
      return p;
    }
    p = walk(from, readlinkSync(p));
  }
  throw new Error(`${path}: too many symbolic links`);
}

/**
 * Writes `text` to `path` through a temporary file beside it and a rename, so a crash or a full
 * disk never leaves an owner's config half written (#1749). A symbolic link, as dotfile managers
 * make, keeps pointing at the file it names, which changes. An existing file keeps its mode, and
 * one this user may not write stays as it is, as a write in place would have failed.
 */
export function replaceFile(path: string, text: string): void {
  const target = linked(path);
  let mode: number | undefined;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {}
  if (mode !== undefined) accessSync(target, constants.W_OK);
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, text, { flag: "wx", ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
