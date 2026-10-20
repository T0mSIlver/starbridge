import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The text of file `path` in this repository. Imported as a Bun macro, it runs when Bun bundles
 * or loads the importing file, so the text lands in the bundle. A text import would do the same,
 * but Bun cannot bundle one file both as text and as code, and the CLI runs
 * mod/hooks/address.ts as code too.
 */
export function source(path: string): string {
  return readFileSync(join(import.meta.dir, "../../..", path), "utf8");
}
