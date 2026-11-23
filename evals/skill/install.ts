/**
 * How the skill eval gives a harness the skill and rule: it runs `starbridge setup --agent <name>`
 * of the version under test in the run's throwaway home, so what the agent gets is what setup
 * writes, with nothing here to drift from it (#1220, #2268). Codex, opencode, Cursor and
 * Antigravity are installed this way; Claude Code and Pi load the arm's plugin and extension by flag.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETUP_AGENTS = ["codex", "opencode", "cursor", "antigravity"] as const;
export type SetupAgent = (typeof SETUP_AGENTS)[number];

/**
 * The environment `setup --agent` runs in: the throwaway home and config folder, and the real
 * PATH, since Codex's step runs `codex plugin add`. Only what the harness reads its config from
 * is set, so Cursor's login folder (an `XDG_CONFIG_HOME` the run keeps) is never written to.
 */
export function setupEnv(
  agent: SetupAgent,
  dirs: { home: string; sb: string; cfg: string },
  path = process.env.PATH ?? "",
): Record<string, string> {
  return {
    HOME: dirs.home,
    PATH: path,
    LANG: process.env.LANG ?? "C.UTF-8",
    STARBRIDGE_CONFIG_DIR: dirs.sb,
    ...(agent === "codex" ? { CODEX_HOME: dirs.cfg } : {}),
    ...(agent === "opencode" ? { XDG_CONFIG_HOME: dirs.cfg } : {}),
  };
}

/** `cli` is a bundle or `cli/src/main.ts`; throws with setup's own output when it fails. */
export function installHarness(
  bun: string,
  cli: string,
  agent: SetupAgent,
  env: Record<string, string>,
): string {
  const r = spawnSync(bun, [cli, "setup", "--agent", agent], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`starbridge setup --agent ${agent}: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** The folders of a checkout the CLI's bundle does not read, left out of the copy. */
const SKIPPED = ["android", "ios", "web", "desktop", "docs", "deploy", "demo", "evals", "landing"];

/**
 * The CLI of an older ref, bundled, so the `before` arm installs what that version's setup wrote.
 * `repo`'s dependencies are linked in, since the archive holds no `node_modules`.
 */
export function buildCliAt(bun: string, repo: string, ref: string, dir: string, out: string) {
  const tar = spawnSync("git", ["-C", repo, "archive", ref], { maxBuffer: 1 << 29 });
  if (tar.status !== 0) throw new Error(`git archive ${ref}: ${tar.stderr}`);
  mkdirSync(dir, { recursive: true });
  const skip = SKIPPED.map((d) => `--exclude=./${d}`);
  if (spawnSync("tar", ["-x", "-C", dir, ...skip], { input: tar.stdout }).status !== 0)
    throw new Error(`tar -x of ${ref}`);
  for (const nm of ["node_modules", "cli/node_modules", "packages/protocol/node_modules"]) {
    mkdirSync(dirname(join(dir, nm)), { recursive: true });
    try {
      symlinkSync(join(repo, nm), join(dir, nm));
    } catch {
      // Already there, or the repo has none: the build says what it misses.
    }
  }
  const r = spawnSync(
    bun,
    ["build", join(dir, "cli/src/main.ts"), "--target", "bun", "--outfile", out],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`bun build of the CLI at ${ref}: ${r.stderr}`);
}
