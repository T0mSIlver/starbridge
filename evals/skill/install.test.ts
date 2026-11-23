import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPlugin } from "../../cli/src/setup/codex-plugin";
import { cursorState } from "../../cli/src/setup/cursor";
import { antigravityState, opencodeState } from "../../cli/src/setup/harnesses";
import { installHarness, SETUP_AGENTS, type SetupAgent, setupEnv } from "./install.ts";

const main = join(import.meta.dir, "../../cli/src/main.ts");

/**
 * The eval's install step is `starbridge setup --agent`, so a harness's files are what setup
 * writes: the state function setup itself uses to decide whether a harness is up to date reads
 * "current" on them (#2268). A hand-copied rule or hooks file would read "outdated".
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
    const env = setupEnv(agent, dirs);
    if (agent === "codex" && !Bun.which("codex")) return;
    installHarness(process.execPath, main, agent, env);
    const sys = { home: dirs.home, ctx: { env } } as Parameters<typeof cursorState>[0];
    expect(states[agent](sys)).toBe("current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
