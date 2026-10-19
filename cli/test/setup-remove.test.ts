import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPluginDir, installCodexPlugin, removeCodexPlugin } from "../src/setup/codex-plugin";
import {
  cursorHooksPath,
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
import { pruneEmpty, withoutAllow } from "../src/setup/remove";
import { defaults, type Sys } from "../src/setup/sys";
import { testCtx } from "./helpers";

function home(name = ""): Sys {
  const dir = join(mkdtempSync(join(tmpdir(), "starbridge-home-")), name);
  mkdirSync(dir, { recursive: true });
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

test("removing the Codex plugin keeps a file the owner put in its folder (#1749)", async () => {
  const sys = home();
  try {
    // No codex here: the files are written, and adding them to Codex fails.
    await installCodexPlugin(sys).catch(() => {});
    const kept = mine(join(codexPluginDir(sys), "notes.md"));
    const done = await removeCodexPlugin(sys);
    expect(existsSync(kept)).toBe(true);
    expect(done).toContain(
      `Removed Starbridge's files from ${codexPluginDir(sys)}; kept ${kept}: setup did not write it.`,
    );
  } finally {
    rmSync(sys.home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "Cursor's hook commands quote a home folder with quotes or a $, and replace the double-quoted ones of before (#1749)",
  () => {
    const sys = home('a "b" $HOME');
    try {
      const dir = cursorScriptsDir(sys);
      const legacy = {
        version: 1,
        hooks: {
          sessionEnd: [{ command: `sh "${dir}/cli.sh" hook session --agent cursor`, timeout: 10 }],
        },
      };
      mkdirSync(join(dir, ".."), { recursive: true });
      writeFileSync(cursorHooksPath(sys), JSON.stringify(legacy));
      installCursorFiles(sys);
      const hooks = JSON.parse(readFileSync(cursorHooksPath(sys), "utf8")).hooks;
      expect(hooks.sessionEnd).toEqual([
        { command: `sh '${dir}/cli.sh' hook session --agent cursor`, timeout: 10 },
      ]);
      const start = spawnSync("sh", ["-c", hooks.sessionStart[0].command], { encoding: "utf8" });
      expect(start.status).toBe(0);
      expect(start.stdout).not.toBe("");
    } finally {
      rmSync(join(sys.home, ".."), { recursive: true, force: true });
    }
  },
);

test("pruneEmpty removes empty folders up to its root, which stays, and nothing past it (#2098)", () => {
  const root = mkdtempSync(join(tmpdir(), "starbridge-prune-"));
  mkdirSync(join(root, "agent/skills/starbridge"), { recursive: true });
  mkdirSync(join(root, "agent/rules"), { recursive: true });
  pruneEmpty(join(root, "agent/skills/starbridge"), join(root, "agent"));
  expect(existsSync(join(root, "agent/skills"))).toBe(false);
  expect(existsSync(join(root, "agent/rules"))).toBe(true);
  // A folder with a file in it stays, and so do its parents; a root outside `dir` changes nothing.
  mine(join(root, "agent/rules/mine.rules"));
  pruneEmpty(join(root, "agent/rules"), join(root, "agent"));
  pruneEmpty(join(root, "other"), join(root, "agent"));
  expect(existsSync(join(root, "agent/rules/mine.rules"))).toBe(true);
  rmSync(join(root, "agent/rules"), { recursive: true });
  pruneEmpty(join(root, "agent"), join(root, "agent"));
  expect(existsSync(join(root, "agent"))).toBe(true);
});

test("withoutAllow keeps the owner's keys in their order (#2098)", () => {
  const s = { model: "opus", permissions: { allow: ["mine", "ours"], deny: [] }, hooks: {} };
  expect(JSON.stringify(withoutAllow(s, ["ours"]))).toBe(
    JSON.stringify({ model: "opus", permissions: { allow: ["mine"], deny: [] }, hooks: {} }),
  );
  const only = { a: 1, permissions: { allow: ["ours"] }, b: 2 };
  expect(JSON.stringify(withoutAllow(only, ["ours"]))).toBe(JSON.stringify({ a: 1, b: 2 }));
});
