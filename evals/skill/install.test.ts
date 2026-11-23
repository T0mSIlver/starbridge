import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPlugin } from "../../cli/src/setup/codex-plugin";
import { cursorState } from "../../cli/src/setup/cursor";
import { antigravityState, opencodeState } from "../../cli/src/setup/harnesses";
import { installHarness, SETUP_AGENTS, type SetupAgent, setupEnv } from "./install.ts";

const main = join(import.meta.dir, "../../cli/src/main.ts");

/** The harnesses' binaries setup looks for, as stubs, so a worker with none installed runs every case. */
const BINARIES: Record<SetupAgent, string> = {
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor-agent",
  antigravity: "agy",
};

/**
 * The eval's install step is `starbridge setup --agent`, so a harness's files are what setup
 * writes: the state function setup itself uses to decide whether a harness is up to date reads
 * "current" on them (#2268). A hand-copied rule or hooks file would read "outdated". Codex's
 * state also needs Codex to have installed the plugin, so with the stub it is only "outdated".
 */
const states: Record<SetupAgent, (sys: Parameters<typeof cursorState>[0]) => string> = {
  codex: codexPlugin,
  opencode: opencodeState,
  cursor: cursorState,
  antigravity: antigravityState,
};

test.each([...SETUP_AGENTS])("the eval's %s install is what setup writes", (agent) => {
  const root = mkdtempSync(join(tmpdir(), "install-test-"));
  try {
    const dirs = { home: join(root, "home"), sb: join(root, "sb"), cfg: join(root, "cfg") };
    const stubs = join(root, "bin");
    mkdirSync(stubs);
    const real = agent === "codex" && Bun.which("codex") !== null;
    if (!real) {
      writeFileSync(join(stubs, BINARIES[agent]), "#!/bin/sh\nexit 0\n");
      chmodSync(join(stubs, BINARIES[agent]), 0o755);
    }
    const env = setupEnv(agent, dirs, `${stubs}:${process.env.PATH}`);
    // A stub Codex installs no plugin, which installHarness reports.
    if (agent === "codex" && !real)
      expect(() => installHarness(process.execPath, main, agent, env)).toThrow("uninstalled");
    else installHarness(process.execPath, main, agent, env);
    const sys = { home: dirs.home, ctx: { env } } as Parameters<typeof cursorState>[0];
    if (agent === "codex" && !real) expect(states[agent](sys)).toBe("outdated");
    else expect(states[agent](sys)).toBe("current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup runs in the throwaway home and loads no .env", () => {
  const root = mkdtempSync(join(tmpdir(), "install-test-"));
  const here = process.cwd();
  try {
    const dirs = { home: join(root, "home"), sb: join(root, "sb"), cfg: join(root, "cfg") };
    const own = join(root, "own");
    mkdirSync(own);
    writeFileSync(join(own, ".env"), `CURSOR_CONFIG_DIR=${join(root, "owner")}\n`);
    const stubs = join(root, "bin");
    mkdirSync(stubs);
    writeFileSync(join(stubs, "cursor-agent"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(stubs, "cursor-agent"), 0o755);
    process.chdir(own);
    installHarness(process.execPath, main, "cursor", setupEnv("cursor", dirs, stubs));
    expect(Bun.file(join(root, "owner", "cli-config.json")).size).toBe(0);
    expect(Bun.file(join(dirs.home, ".cursor", "cli-config.json")).size).toBeGreaterThan(0);
  } finally {
    process.chdir(here);
    rmSync(root, { recursive: true, force: true });
  }
});
