// A real commit through .githooks/pre-commit (#1670). Git exports GIT_DIR to a hook, so a git
// command the hook runs from a package folder once staged the formatted files a second time at
// the repo root (src/foo.ts beside web/src/foo.ts). A linked worktree is where agents commit.
import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hook = resolve(import.meta.dir, "../../.githooks/pre-commit");

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "starbridge-hook-"));
  const main = join(root, "main");
  mkdirSync(join(main, "web/src"), { recursive: true });
  mkdirSync(join(main, "web/node_modules/.bin"), { recursive: true });
  writeFileSync(join(main, "web/biome.json"), "{}\n");
  writeFileSync(join(main, "web/package.json"), "{}\n");
  writeFileSync(join(main, "web/src/foo.ts"), "a\n");
  writeFileSync(join(main, ".gitignore"), "node_modules\n");
  // A stand-in Biome that rewrites each file it is given.
  const biome = join(main, "web/node_modules/.bin/biome");
  writeFileSync(
    biome,
    '#!/bin/sh\nfor f; do [ -f "$f" ] && echo formatted >> "$f"; done; exit 0\n',
  );
  chmodSync(biome, 0o755);
  git(root, "init", "-q", main);
  git(main, "config", "user.email", "t@example.com");
  git(main, "config", "user.name", "t");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  copyFileSync(hook, join(main, ".git/hooks/pre-commit"));
  chmodSync(join(main, ".git/hooks/pre-commit"), 0o755);
  return main;
}

for (const linked of [false, true]) {
  test(`pre-commit stages a formatted package file once, at its package path (${linked ? "linked worktree" : "main checkout"})`, () => {
    const main = setup();
    try {
      let dir = main;
      if (linked) {
        dir = `${main}-wt`;
        git(main, "worktree", "add", "-q", "-b", "w", dir);
        mkdirSync(join(dir, "web/node_modules/.bin"), { recursive: true });
        copyFileSync(
          join(main, "web/node_modules/.bin/biome"),
          join(dir, "web/node_modules/.bin/biome"),
        );
        chmodSync(join(dir, "web/node_modules/.bin/biome"), 0o755);
      }
      writeFileSync(join(dir, "web/src/foo.ts"), "b\n");
      git(dir, "add", "web/src/foo.ts");
      git(dir, "commit", "-q", "-m", "change");
      expect(git(dir, "show", "--name-only", "--format=", "HEAD").trim()).toBe("web/src/foo.ts");
      expect(git(dir, "show", "HEAD:web/src/foo.ts")).toBe("b\nformatted\n");
      expect(git(dir, "status", "--porcelain")).toBe("");
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(`${main}-wt`, { recursive: true, force: true });
    }
  });
}

// install.mjs from an older branch must not put back an older hook in the hooks directory every
// worktree shares (#1733). The installer runs from a copy of .githooks in a scratch repository,
// as pnpm install's prepare runs it.
const githooks = resolve(import.meta.dir, "../../.githooks");

function installFrom(repo: string, hooks: Record<string, string>): void {
  const dir = join(repo, ".githooks");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  copyFileSync(join(githooks, "install.mjs"), join(dir, "install.mjs"));
  for (const [name, body] of Object.entries(hooks)) writeFileSync(join(dir, name), body);
  const r = Bun.spawnSync(["node", join(dir, "install.mjs")], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

const stamped = (v: number, body: string) =>
  `#!/bin/sh\n# starbridge-hook-version: ${v}\n${body}\n`;

test("install.mjs replaces an installed hook only with a higher version", async () => {
  const repo = mkdtempSync(join(tmpdir(), "starbridge-install-"));
  try {
    git(repo, "init", "-q");
    const installed = join(repo, ".git/hooks/pre-commit");
    const read = () => Bun.file(installed).text();

    writeFileSync(installed, "#!/bin/sh\nunstamped\n");
    installFrom(repo, { "pre-commit": stamped(2, "new") });
    await expect(read()).resolves.toBe(stamped(2, "new"));

    installFrom(repo, { "pre-commit": stamped(1, "old") });
    await expect(read()).resolves.toBe(stamped(2, "new"));
    installFrom(repo, { "pre-commit": stamped(2, "same version") });
    await expect(read()).resolves.toBe(stamped(2, "new"));

    installFrom(repo, { "pre-commit": stamped(3, "newer") });
    await expect(read()).resolves.toBe(stamped(3, "newer"));
    expect(Bun.spawnSync(["test", "-x", installed]).exitCode).toBe(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("every hook carries a version stamp", () => {
  for (const name of readdirSync(githooks)) {
    if (name === "install.mjs") continue;
    expect(readFileSync(join(githooks, name), "utf8")).toMatch(/^# starbridge-hook-version: \d+$/m);
  }
});
