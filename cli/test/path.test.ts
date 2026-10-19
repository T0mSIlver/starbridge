import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join as hostJoin, posix } from "node:path";
import { CLI_PATH } from "../src/config";
import { pathStep, recordSelf, removePathLines } from "../src/setup/path";
import { defaults, type Prompt, type Sys } from "../src/setup/sys";
import { bareEnv, SYSTEM_PATH, sh, slashes, type TestCtx, testCtx } from "./helpers";

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

test("the PATH step says nothing when the folder is on the PATH, and adds it without asking when it is not (#612, #2121)", async () => {
  expect(
    await pathStep(
      sys({ PATH: ["/opt/homebrew/bin", "/usr/bin"].join(delimiter) }, [
        "/opt/homebrew/bin/starbridge",
      ]),
    ),
  ).toEqual([]);
  const asked: string[] = [];
  const s = sys({ SHELL: "/bin/bash", PATH: "/usr/bin" }, [], {
    ...defaults,
    confirm: async (q) => !!asked.push(q),
  });
  const bin = join(s.home, ".local/bin");
  const lines = await pathStep({ ...s, self: [join(bin, "starbridge")] });
  expect(asked).toEqual([]);
  expect((s.ctx as TestCtx).lines).toContain(
    `Added ${bin} to your PATH in ~/.profile (uninstall removes it).`,
  );
  expect(readFileSync(join(s.home, ".profile"), "utf8")).toContain(
    'export PATH="$HOME/.local/bin:$PATH"',
  );
  expect(lines[0]).toStartWith("One more step: `starbridge` is not on this terminal's PATH yet.");
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
  writeFileSync(join(cfg, CLI_PATH), `${join(recorded, "starbridge")}\n`, { mode: 0o600 });
  expect(run().out).toBe("recorded hook settle");
  writeFileSync(join(cfg, CLI_PATH), `${join(dir, "gone", "starbridge")}\n`);
  expect(run(onPath).out).toBe("path hook settle");
  const none = run();
  expect([none.code, none.out]).toEqual([1, ""]);
  expect(none.err).toContain("run `starbridge setup`");

  // A relative path, a binary others may write, or a cli-path others may write counts for nothing.
  writeFileSync(join(cfg, CLI_PATH), "recorded/starbridge\n");
  expect(run(onPath).out).toBe("path hook settle");
  if (process.platform === "win32") return;
  writeFileSync(join(cfg, CLI_PATH), `${join(recorded, "starbridge")}\n`);
  chmodSync(join(recorded, "starbridge"), 0o775);
  expect(run(onPath).out).toBe("path hook settle");
  chmodSync(join(recorded, "starbridge"), 0o755);
  chmodSync(join(cfg, CLI_PATH), 0o606);
  expect(run(onPath).out).toBe("path hook settle");
  chmodSync(join(cfg, CLI_PATH), 0o600);
  expect(run(onPath).out).toBe("recorded hook settle");
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

test("uninstall takes out the PATH line setup added, only while it is as setup wrote it (#1494)", async () => {
  const s = sys({ SHELL: "/bin/zsh", PATH: "/usr/bin" }, []);
  const withSelf = { ...s, self: [join(s.home, ".local/bin/starbridge")] };
  // A file setup created goes; one it added to is left as it was.
  await pathStep(withSelf);
  const bashrc = join(s.home, ".bashrc");
  writeFileSync(
    bashrc,
    'alias l=ls\n\n# Added by starbridge setup\nexport PATH="$HOME/.local/bin:$PATH"\n',
  );
  const fish = join(s.home, ".config/fish/config.fish");
  mkdirSync(join(fish, ".."), { recursive: true });
  writeFileSync(
    fish,
    `set x 1\n\n# Added by starbridge setup\nfish_add_path ${s.home}/.local/bin\n`,
  );
  // A line the owner changed stays, whatever they changed.
  const profile = join(s.home, ".profile");
  const changed = [":$PATH:/opt/x", ":$PATH", "/opt/tool:$HOME/.local/bin:$PATH"]
    .map(
      (end, i) =>
        `\n# Added by starbridge setup\nexport PATH="${i === 1 ? "$HOME/bin" : i === 0 ? "$HOME/.local/bin" : ""}${end}"\n`,
    )
    .join("");
  writeFileSync(profile, changed);
  const bin = join(s.home, ".local/bin");
  expect(removePathLines(s, bin).sort()).toEqual([join(s.home, ".zshrc"), bashrc, fish].sort());
  expect(existsSync(join(s.home, ".zshrc"))).toBe(false);
  expect(readFileSync(bashrc, "utf8")).toBe("alias l=ls\n");
  expect(readFileSync(fish, "utf8")).toBe("set x 1\n");
  expect(readFileSync(profile, "utf8")).toBe(changed);
  expect(removePathLines(s, bin)).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "a folder with a space, a quote or a $ goes on the PATH as itself, in sh and in fish, and uninstall takes it out (#1749)",
  async () => {
    for (const shell of ["/bin/bash", "/usr/bin/fish"]) {
      const s = sys({ SHELL: shell, PATH: "/usr/bin" }, []);
      const dir = `/opt/it's "my" $HOME tools/bin`;
      const lines = await pathStep({ ...s, self: [`${dir}/starbridge`] });
      const file = join(s.home, shell.endsWith("fish") ? ".config/fish/config.fish" : ".profile");
      const line = readFileSync(file, "utf8").trim().split("\n").at(-1) as string;
      if (shell.endsWith("fish"))
        expect(line).toBe(`fish_add_path '/opt/it\\'s "my" $HOME tools/bin'`);
      else {
        expect(line).toBe(`export PATH='/opt/it'\\''s "my" $HOME tools/bin':"$PATH"`);
        const r = spawnSync("sh", ["-c", `${line}; printf %s "$PATH"`], { encoding: "utf8" });
        expect(r.stdout).toBe(`${dir}:${process.env.PATH}`);
        expect(lines.at(-1)).toBe(`  ${line}`);
      }
      expect(removePathLines(s, dir)).toEqual([file]);
      expect(existsSync(file)).toBe(false);
    }
    // A line an earlier release wrote, unquoted, still comes out.
    const old = sys({ SHELL: "/bin/bash", PATH: "/usr/bin" }, []);
    const profile = join(old.home, ".profile");
    writeFileSync(profile, '\n# Added by starbridge setup\nexport PATH="$HOME/my tools:$PATH"\n');
    expect(removePathLines(old, join(old.home, "my tools"))).toEqual([profile]);
    // In the home folder, $HOME stays a variable, quoted.
    const s = sys({ SHELL: "/bin/bash", PATH: "/usr/bin" }, []);
    await pathStep({ ...s, self: [join(s.home, "my tools/starbridge")] });
    expect(readFileSync(join(s.home, ".profile"), "utf8")).toContain(
      `export PATH="$HOME"'/my tools':"$PATH"`,
    );
  },
);
