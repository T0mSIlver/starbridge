import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareEnv, SYSTEM_PATH } from "./helpers";

const SCRIPT = join(import.meta.dir, "../../plugin/hooks/remote.sh");

/** A plugin folder as Claude desktop's copies are: a manifest, and `hooks/` only when `hooks`. */
function plugin(root: string, dir: string, name: string, hooks: boolean): string {
  mkdirSync(join(root, dir, ".claude-plugin"), { recursive: true });
  // Pretty-printed, the author's name after the plugin's, as Starbridge's manifests are.
  writeFileSync(
    join(root, dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "0.1.5", author: { name: "Tom" } }, null, 2),
  );
  if (hooks) {
    mkdirSync(join(root, dir, "hooks"));
    writeFileSync(join(root, dir, "hooks", "hooks.json"), "{}");
  }
  return join(root, dir);
}

/** remote.sh run as a hook of a process started with `args`; whether it ran the script. */
async function remote(args: string[], name: string): Promise<{ code: number; ran: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "starbridge-remote-"));
  writeFileSync(join(root, "script.sh"), `echo "$1" > "${root}/ran"; cat >> "${root}/ran"\n`);
  // Stands in for Claude Code: a process whose arguments are those it runs with. A last command
  // after sleep keeps a shell such as macOS bash from exec-ing it in its place.
  const claude = Bun.spawn(["/bin/sh", "-c", "sleep 30; exit", "claude", ...args]);
  try {
    const r = Bun.spawnSync(["/bin/sh", SCRIPT, name, join(root, "script.sh"), "arg"], {
      env: bareEnv({ PATH: SYSTEM_PATH, CLAUDE_PID: String(claude.pid) }),
      stdin: new TextEncoder().encode("{}"),
    });
    const ran = await Bun.file(join(root, "ran")).exists();
    if (ran) expect(await Bun.file(join(root, "ran")).text()).toBe("arg\n{}");
    return { code: r.exitCode ?? -1, ran };
  } finally {
    claude.kill();
  }
}

test.skipIf(process.platform === "win32")(
  "starbridge-remote's hooks run only where Claude desktop replaced the plugin with a hookless copy (#2107)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "starbridge-copies-"));
    const hookless = plugin(root, "4917e9633546766b", "starbridge", false);
    const mod = plugin(root, "f1c90365715d30a6", "starbridge-mod", false);
    const full = plugin(root, "049f0f053f7ea84d", "starbridge", true);
    const other = plugin(root, "a71fbe145223bcc9", "localvoxtral", false);
    expect(await remote(["--resume=s-1", "--plugin-dir", hookless], "starbridge")).toEqual({
      code: 0,
      ran: true,
    });
    expect(
      await remote([`--plugin-dir=${mod}`, `--plugin-dir=${other}`], "starbridge-mod"),
    ).toEqual({ code: 0, ran: true });
    // A copy with its hooks, another plugin's, or none: the installed plugin acts.
    for (const args of [["--plugin-dir", full], ["--plugin-dir", other], ["--resume=s-1"], []])
      expect(await remote(args, "starbridge")).toEqual({ code: 0, ran: false });
    expect(await remote(["--plugin-dir", mod], "starbridge")).toEqual({ code: 0, ran: false });
  },
);

test.skipIf(process.platform === "win32")(
  "without a script, remote.sh's exit says whether the mod's plugin was replaced, read from its parent (#2107)",
  () => {
    const root = mkdtempSync(join(tmpdir(), "starbridge-copies-"));
    const mod = plugin(root, "f1c90365715d30a6", "starbridge-mod", false);
    // The mod runs the check straight from Claude Code; an inherited CLAUDE_PID is not its own.
    const check = (args: string[]) =>
      Bun.spawnSync(
        ["/bin/sh", "-c", `sh "${SCRIPT}" starbridge-mod; exit $?`, "claude", ...args],
        {
          env: bareEnv({ PATH: SYSTEM_PATH, CLAUDE_PID: "1" }),
        },
      ).exitCode;
    expect(check(["--plugin-dir", mod])).toBe(0);
    expect(check(["--resume=s-1"])).toBe(1);
  },
);
