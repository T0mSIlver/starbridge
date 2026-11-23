/**
 * How the skill eval gives a harness the skill and rule: it runs `starbridge setup --agent <name>`
 * of the version under test in the run's throwaway home, so what the agent gets is what setup
 * writes, with nothing here to drift from it (#1220, #2268). Codex, opencode, Cursor and
 * Antigravity are installed this way; Claude Code and Pi load the arm's plugin and extension by flag.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

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

/**
 * `cli` is a bundle or `cli/src/main.ts`; throws with setup's own output when it fails. It runs in
 * the throwaway home with no `.env` loaded, so neither the caller's folder nor a `.env` there can
 * point setup at the owner's own config.
 */
export function installHarness(
  bun: string,
  cli: string,
  agent: SetupAgent,
  env: Record<string, string>,
): string {
  mkdirSync(env.HOME as string, { recursive: true });
  const r = spawnSync(bun, ["--no-env-file", cli, "setup", "--agent", agent], {
    env,
    cwd: env.HOME,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`starbridge setup --agent ${agent}: ${r.stdout}${r.stderr}`);
  // Setup notes a failed `codex plugin add` and exits 0, which would leave a run with no rule. A
  // version that has no Codex plugin says nothing of one.
  if (agent === "codex" && /plugin/i.test(r.stdout)) {
    const config = join(env.CODEX_HOME as string, "config.toml");
    const text = existsSync(config) ? readFileSync(config, "utf8") : "";
    if (!text.includes('[plugins."starbridge@starbridge-cli"]'))
      throw new Error(`starbridge setup --agent codex left the plugin uninstalled: ${r.stdout}`);
  }
  return r.stdout;
}

/** The folders of a checkout the CLI's bundle does not read, left out of the copy. */
const SKIPPED = ["android", "ios", "web", "desktop", "docs", "deploy", "demo", "evals", "landing"];

/**
 * Links the packages of `repo`'s `<rel>/node_modules` into `dir`'s, one by one. A workspace
 * package (a link into the checkout, outside any `node_modules`) goes to the archive's own copy,
 * so the archived CLI never loads the checkout's `packages/protocol`.
 */
function linkModules(repo: string, dir: string, rel: string) {
  const from = join(repo, rel, "node_modules");
  if (!existsSync(from)) return;
  const to = join(dir, rel, "node_modules");
  const link = (name: string) => {
    let target: string;
    try {
      target = realpathSync(join(from, name));
    } catch (e) {
      // A dangling link, such as a removed local package: the build says what it needs.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const workspace =
      !relative(repo, target).startsWith("..") && !target.includes(`${sep}node_modules${sep}`);
    try {
      symlinkSync(workspace ? join(dir, relative(repo, target)) : target, join(to, name));
    } catch {
      // Already linked.
    }
  };
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (!name.startsWith("@")) link(name);
    else {
      mkdirSync(join(to, name), { recursive: true });
      for (const sub of readdirSync(join(from, name))) link(join(name, sub));
    }
  }
}

/**
 * The CLI of an older ref, bundled, so the `before` arm installs what that version's setup wrote.
 * The archive holds no `node_modules`: `repo`'s third-party packages are linked in, and its
 * workspace packages are the archive's own.
 */
export function buildCliAt(bun: string, repo: string, ref: string, dir: string, out: string) {
  const tar = spawnSync("git", ["-C", repo, "archive", ref], { maxBuffer: 1 << 29 });
  if (tar.status !== 0) throw new Error(`git archive ${ref}: ${tar.stderr}`);
  mkdirSync(dir, { recursive: true });
  const skip = SKIPPED.map((d) => `--exclude=./${d}`);
  if (spawnSync("tar", ["-x", "-C", dir, ...skip], { input: tar.stdout }).status !== 0)
    throw new Error(`tar -x of ${ref}`);
  for (const rel of [".", "cli", "packages/protocol"]) linkModules(repo, dir, rel);
  const r = spawnSync(
    bun,
    ["build", join(dir, "cli/src/main.ts"), "--target", "bun", "--outfile", out],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`bun build of the CLI at ${ref}: ${r.stderr}`);
}
