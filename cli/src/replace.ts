import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Where `path` leads through its symbolic links, followed even to a file not there yet. */
function linked(path: string): string {
  let p = path;
  for (let i = 0; i < 40; i++) {
    let link: boolean;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch {
      return p;
    }
    if (!link) return p;
    p = resolve(dirname(p), readlinkSync(p));
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
