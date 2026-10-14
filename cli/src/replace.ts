import { chmodSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `text` to `path` through a temporary file beside it and a rename, so a crash or a full
 * disk never leaves an owner's config half written (#1749). An existing file keeps its mode, and a
 * symbolic link, as dotfile managers make, keeps pointing at the file it names, which changes.
 */
export function replaceFile(path: string, text: string): void {
  let target = path;
  let mode: number | undefined;
  try {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o7777;
  } catch {}
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
