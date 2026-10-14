import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFile } from "../src/replace";

const WINDOWS = process.platform === "win32";

test("an owner's config is replaced whole, keeping its mode, and through a link (#1749)", () => {
  const dir = mkdtempSync(join(tmpdir(), "starbridge-replace-"));
  const file = join(dir, "settings.json");
  replaceFile(file, "{}\n");
  expect(readFileSync(file, "utf8")).toBe("{}\n");
  writeFileSync(file, "old");
  chmodSync(file, 0o640);
  replaceFile(file, "new");
  expect(readFileSync(file, "utf8")).toBe("new");
  if (!WINDOWS) expect(statSync(file).mode & 0o777).toBe(0o640);
  // No temporary file is left beside it.
  expect(readdirSync(dir)).toEqual(["settings.json"]);
  if (WINDOWS) return;
  // A dotfile manager's link stays a link; the file it names changes.
  const link = join(dir, "linked.json");
  symlinkSync(file, link);
  replaceFile(link, "through");
  expect(readlinkSync(link)).toBe(file);
  expect(readFileSync(file, "utf8")).toBe("through");
  // A link to a file not there yet creates it.
  const dangling = join(dir, "dangling.json");
  symlinkSync(join(dir, "target.json"), dangling);
  replaceFile(dangling, "made");
  expect(readlinkSync(dangling)).toBe(join(dir, "target.json"));
  expect(readFileSync(join(dir, "target.json"), "utf8")).toBe("made");
  // A link through a linked folder and `..` lands where the file system says, not where the
  // path's words do.
  const elsewhere = join(dir, "dotfiles");
  mkdirSync(join(elsewhere, "sub"), { recursive: true });
  symlinkSync(join(elsewhere, "sub"), join(dir, "alias"));
  writeFileSync(join(elsewhere, "real.json"), "old");
  const up = join(dir, "up.json");
  symlinkSync("alias/../real.json", up);
  replaceFile(up, "via");
  expect(readFileSync(join(elsewhere, "real.json"), "utf8")).toBe("via");
  rmSync(join(elsewhere, "real.json"));
  replaceFile(up, "made again");
  expect(readFileSync(join(elsewhere, "real.json"), "utf8")).toBe("made again");
  expect(readlinkSync(up)).toBe("alias/../real.json");
  // A file this user may not write stays, as a write in place would have left it.
  if (process.getuid?.() === 0) return;
  chmodSync(file, 0o444);
  expect(() => replaceFile(file, "over")).toThrow();
  expect(readFileSync(file, "utf8")).toBe("through");
});
