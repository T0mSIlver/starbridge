import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cursorScriptsDir,
  cursorSkillDir,
  installCursorFiles,
  removeCursorFiles,
} from "../src/setup/cursor";
import {
  antigravityDir,
  antigravityState,
  codexSkillDir,
  installAntigravity,
  installCodexSkill,
  installOpencode,
  opencodeDir,
  removeAntigravity,
  removeCodexSkill,
  removeOpencode,
} from "../src/setup/harnesses";
import { defaults, type Sys } from "../src/setup/sys";
import { testCtx } from "./helpers";

function home(): Sys {
  const dir = mkdtempSync(join(tmpdir(), "starbridge-home-"));
  return {
    ctx: testCtx({ HOME: dir }),
    home: dir,
    platform: "linux",
    arch: "x64",
    uid: 1000,
    prompt: defaults,
    self: ["starbridge"],
  };
}

/** Puts an owner's file at `path`, in a folder of its own as a skill's `references/` is. */
function mine(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "the owner's\n");
  return path;
}

test.each([
  [
    "the Codex skill",
    (sys: Sys) => installCodexSkill(sys),
    (sys: Sys) => [removeCodexSkill(sys)],
    (sys: Sys) => codexSkillDir(sys),
  ],
  [
    "opencode's code",
    (sys: Sys) => installOpencode(sys),
    (sys: Sys) => removeOpencode(sys),
    (sys: Sys) => join(opencodeDir(sys), "starbridge"),
  ],
  [
    "the Antigravity plugin",
    (sys: Sys) => installAntigravity(sys),
    (sys: Sys) => [removeAntigravity(sys)],
    (sys: Sys) => antigravityDir(sys),
  ],
  [
    "Cursor's scripts",
    (sys: Sys) => installCursorFiles(sys),
    (sys: Sys) => removeCursorFiles(sys),
    (sys: Sys) => cursorScriptsDir(sys),
  ],
  [
    "Cursor's skill",
    (sys: Sys) => installCursorFiles(sys),
    (sys: Sys) => removeCursorFiles(sys),
    (sys: Sys) => cursorSkillDir(sys),
  ],
] as const)(
  "removing %s keeps a file the owner put in its folder (#1324)",
  (_, install, remove, folder) => {
    const sys = home();
    try {
      install(sys);
      const kept = mine(join(folder(sys), "references", "notes.md"));
      const done = remove(sys);
      expect(existsSync(kept)).toBe(true);
      expect(done).toContain(
        `Removed Starbridge's files from ${folder(sys)}; kept ${kept}: setup did not write it.`,
      );
      // Without it, the folder goes whole.
      rmSync(kept);
      install(sys);
      remove(sys);
      expect(existsSync(folder(sys))).toBe(false);
    } finally {
      rmSync(sys.home, { recursive: true, force: true });
    }
  },
);

test("an Antigravity plugin that lost its rule is still Starbridge's, so setup repairs it (#1334)", () => {
  const sys = home();
  try {
    installAntigravity(sys);
    const rule = join(antigravityDir(sys), "rules", "starbridge.md");
    rmSync(rule);
    expect(antigravityState(sys)).toBe("outdated");
    installAntigravity(sys);
    expect(antigravityState(sys)).toBe("current");
    // A rule without the marker is the owner's, and so is the plugin.
    writeFileSync(rule, "my own rule\n");
    expect(antigravityState(sys)).toBe("foreign");
  } finally {
    rmSync(sys.home, { recursive: true, force: true });
  }
});
