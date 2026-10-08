import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join as hostJoin, posix } from "node:path";
import { CLI_PATH } from "../src/config";
import { pathStep, recordSelf } from "../src/setup/path";
import { defaults, type Prompt, type Sys } from "../src/setup/sys";
import { bareEnv, SYSTEM_PATH, sh, slashes, testCtx } from "./helpers";

// A Mac's paths, which the files on any host take: Windows reads forward slashes too.
const { join } = posix;

function sys(env: Record<string, string>, self: string[], prompt: Prompt = defaults): Sys {
  const home = slashes(mkdtempSync(hostJoin(tmpdir(), "starbridge-path-")));
  const ctx = testCtx({ HOME: home, ...env });
  return { ctx, home, platform: "darwin", arch: "arm64", uid: 501, prompt, self };
}

test("setup records the binary's path for the hooks, and forgets it for an npm bundle off the PATH (#612)", () => {
  const s = sys({}, ["/Users/me/.local/bin/starbridge"]);
  recordSelf(s);
  const file = hostJoin(s.ctx.store.dir, CLI_PATH);
  expect(readFileSync(file, "utf8")).toBe("/Users/me/.local/bin/starbridge\n");
  recordSelf({ ...s, self: ["/usr/bin/node", "/opt/npm/starbridge/dist/starbridge.js"] });
  expect(existsSync(file)).toBe(false);
});

test("the PATH step adds the install folder to zsh's startup file once, and ends setup with how to use it now (#612)", async () => {
  const s = sys({ SHELL: "/bin/zsh", PATH: ["/usr/bin", "/bin"].join(delimiter) }, []);
  const self = join(s.home, ".local/bin/starbridge");
  const withSelf = { ...s, self: [self] };
  expect(await pathStep(withSelf)).toEqual([
    "One more step: `starbridge` is not on this terminal's PATH yet. Open a new terminal, or run:",
    `  export PATH="${join(s.home, ".local/bin")}:$PATH"`,
  ]);
  const zshrc = readFileSync(join(s.home, ".zshrc"), "utf8");
  expect(zshrc).toBe('\n# Added by starbridge setup\nexport PATH="$HOME/.local/bin:$PATH"\n');
  // A second setup finds the line and asks nothing.
  const asked: string[] = [];
  const noisy = {
    ...withSelf,
    prompt: { ...defaults, confirm: async (q: string) => !!asked.push(q) },
  };
  expect(await pathStep(noisy)).toHaveLength(2);
  expect(asked).toEqual([]);
  expect(readFileSync(join(s.home, ".zshrc"), "utf8")).toBe(zshrc);
});

test("the PATH step says nothing when the folder is on the PATH, and the line to add when declined (#612)", async () => {
  expect(
    await pathStep(
      sys({ PATH: ["/opt/homebrew/bin", "/usr/bin"].join(delimiter) }, [
        "/opt/homebrew/bin/starbridge",
      ]),
    ),
  ).toEqual([]);
  const no = { ...defaults, confirm: async () => false };
  const s = sys({ SHELL: "/bin/bash", PATH: "/usr/bin" }, [], no);
  const lines = await pathStep({ ...s, self: [join(s.home, ".local/bin/starbridge")] });
  expect(lines).toEqual([
    "One more step: `starbridge` is not on your PATH. Add this line to ~/.profile:",
    '  export PATH="$HOME/.local/bin:$PATH"',
  ]);
  expect(existsSync(join(s.home, ".bash_profile"))).toBe(false);
});

test("the plugin's hooks start the CLI setup recorded, else the one on the PATH, else say to run setup (#612)", () => {
  const dir = slashes(mkdtempSync(hostJoin(tmpdir(), "starbridge-cli-sh-")));
  const cfg = join(dir, "cfg");
  const recorded = join(dir, "recorded");
  // Not `bin`: Git's sh on Windows puts $HOME/bin on the PATH.
  const onPath = join(dir, "path");
  mkdirSync(cfg);
  mkdirSync(recorded);
  mkdirSync(onPath);
  for (const [where, name] of [
    [recorded, "recorded"],
    [onPath, "path"],
  ] as const)
    writeFileSync(join(where, "starbridge"), `#!/bin/sh\necho ${name} "$@"\n`, { mode: 0o755 });
  const script = hostJoin(import.meta.dir, "../../plugin/hooks/cli.sh");
  const run = (...dirs: string[]) => {
    const r = Bun.spawnSync([sh(), script, "hook", "settle"], {
      env: bareEnv({
        PATH: [...dirs, SYSTEM_PATH].join(delimiter),
        HOME: dir,
        STARBRIDGE_CONFIG_DIR: cfg,
      }),
    });
    return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  };
  expect(run(onPath)).toEqual({ code: 0, out: "path hook settle", err: "" });
  writeFileSync(join(cfg, CLI_PATH), `${join(recorded, "starbridge")}\n`);
  expect(run().out).toBe("recorded hook settle");
  writeFileSync(join(cfg, CLI_PATH), `${join(dir, "gone", "starbridge")}\n`);
  expect(run(onPath).out).toBe("path hook settle");
  const none = run();
  expect([none.code, none.out]).toEqual([1, ""]);
  expect(none.err).toContain("run `starbridge setup`");
});

test("on macOS, bash's line goes where its login shell reads it, and a $HOME spelling counts as there (#612)", async () => {
  const s = sys({ SHELL: "/bin/bash", PATH: "/usr/bin" }, []);
  writeFileSync(
    join(s.home, ".profile"),
    '. "$HOME/.cargo/env"\nexport PATH="$HOME/.local/bin:$PATH"\n',
  );
  const asked: string[] = [];
  const prompt = { ...defaults, confirm: async (q: string) => !!asked.push(q) };
  await pathStep({ ...s, prompt, self: [join(s.home, ".local/bin/starbridge")] });
  expect(asked).toEqual([]);
  expect(existsSync(join(s.home, ".bash_profile"))).toBe(false);
});
