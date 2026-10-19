/**
 * The path a new user takes, end to end (#2096, #2119): install.sh installs the compiled binary
 * from a signed release, `starbridge setup` runs on a terminal with every agent it can fake, pairs with a
 * server and gets its test card answered from the phone, then `starbridge uninstall` takes it all
 * out. The walk checks that nothing setup wrote is left, that every file the owner had is byte for
 * byte as before, and that the agent and lingering are off again. The npm package walks the same
 * path. Linux and macOS, each with its own service manager faked. A throwaway HOME with its own
 * XDG_RUNTIME_DIR, so nothing reaches this machine's agent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { platformAsset } from "../src/release";
import { VERSION } from "../src/version";
import { signer } from "./fake-releases";
import { FAKE_BIN } from "./helpers";

const CLI = join(import.meta.dir, "..");
const LINUX = process.platform === "linux";
const WALK_BIN = join(import.meta.dir, "fixtures", "walk-bin");

/** Files an owner already has before installing Starbridge, which must come out unchanged. */
const OWNER_FILES: Record<string, string> = {
  ".profile": 'if [ -d "$HOME/bin" ] ; then\n    PATH="$HOME/bin:$PATH"\nfi\n',
  ".bashrc": "alias ll='ls -alF'\n",
  ".claude/settings.json": `${JSON.stringify(
    {
      model: "opus",
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
      },
    },
    null,
    2,
  )}\n`,
  ".claude/CLAUDE.md": "# Mine\n",
  ".codex/config.toml":
    'model = "gpt-6.1-sol"\n\n[projects."/home/me/work"]\ntrust_level = "trusted"\n',
  ".codex/AGENTS.md": "Be brief.\n",
  ".config/opencode/opencode.json": `${JSON.stringify({ theme: "tokyonight" }, null, 2)}\n`,
  // An entry of the owner's that runs a script of Starbridge's folder stays theirs (#1493).
  ".cursor/hooks.json": `${JSON.stringify(
    {
      version: 1,
      hooks: {
        stop: [{ command: "./mine.sh" }],
        sessionStart: [
          { command: "sh ~/.cursor/starbridge/cli.sh hook session --agent cursor -v" },
        ],
      },
    },
    null,
    2,
  )}\n`,
  // Files of the owner's inside folders setup writes into stay, with their folders (#1324).
  ".codex/skills/starbridge/references/mine.md": "# Mine\n",
  ".config/opencode/starbridge/notes.md": "mine\n",
  ".cursor/mine.sh": "#!/bin/sh\n",
  // pi-permission-system with a rule of the owner's that setup also adds (#2130).
  ".pi/agent/extensions/pi-permission-system/config.json": `${JSON.stringify(
    { permission: { skill: { starbridge: "allow" } }, authorizerChain: ["judge"] },
    null,
    2,
  )}\n`,
  ".pi/agent/settings.json": JSON.stringify({ packages: ["npm:pi-mine"] }, null, 2),
  ".gemini/antigravity/mcp_config.json": `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
  ".local/share/mine.txt": "mine\n",
};

/**
 * What the agents leave after Starbridge's uninstall ran their own removal: Claude Code 2.1 keeps
 * an empty `extraKnownMarketplaces`, Codex 0.163 its plugin cache folders, Pi 1.2 the .gitignore
 * it writes beside git packages. Checked with the real agents in a throwaway HOME.
 */
const AGENTS_LEAVE = {
  changed: { ".claude/settings.json": { extraKnownMarketplaces: {} } } as Record<string, object>,
  left: [".codex/plugins", ".codex/plugins/cache", ".pi/agent/git", ".pi/agent/git/.gitignore"],
};

/**
 * What the walk finds left today, until its issue is fixed. The walk fails as soon as one is no
 * longer left, so the fix takes it off this list.
 */
const KNOWN = { left: [] as string[], changed: [] as string[] };

type Snapshot = Map<string, string>;

/** Every path under `root`, with a file's text, a link's target, or "dir". */
function snapshot(root: string): Snapshot {
  const out: Snapshot = new Map();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out.set(rel, `-> ${readlinkSync(path)}`);
      else if (st.isDirectory()) {
        out.set(rel, "dir");
        walk(path);
      } else out.set(rel, readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

/** A JSON file's value with its keys in order, so only spacing may differ; other files as is. */
function same(path: string, a: string, b: string | undefined): boolean {
  if (b === undefined || !path.endsWith(".json")) return a === b;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
}

/**
 * What uninstall left in HOME that was not there before, and which of the owner's files it
 * changed or removed, past what the agents themselves leave.
 */
function leftovers(before: Snapshot, after: Snapshot, theirs: string[] = []) {
  const expected = new Map(before);
  for (const [path, extra] of Object.entries(AGENTS_LEAVE.changed)) {
    const was = before.get(path);
    if (was) expected.set(path, JSON.stringify({ ...JSON.parse(was), ...extra }));
  }
  return {
    left: [...after.keys()]
      .filter((p) => !before.has(p) && ![...AGENTS_LEAVE.left, ...theirs].includes(p))
      .sort(),
    changed: [...expected]
      .filter(([p, v]) => !same(p, v, after.get(p)))
      .map(([p]) => `${p}${after.has(p) ? "" : " (gone)"}`)
      .sort(),
  };
}

interface Step {
  prompt: string;
  answer: string;
}

/**
 * Runs `cmd` on a terminal as the owner at it would: Enter at every question, but `answers`
 * picks another for a question it matches. The phone approves each pairing code and answers
 * setup's test card with its first option. Returns the screen and each question asked.
 */
async function onTerminal(
  server: LiveServer,
  cmd: string[],
  env: Record<string, string>,
  answers: [RegExp, string][] = [],
  limitMs = 120_000,
) {
  let screen = "";
  let handled = 0;
  let quietSince = Date.now();
  const steps: Step[] = [];
  const approved = new Set<string>();
  let answeredCard = false;
  const proc = Bun.spawn(cmd, {
    env,
    cwd: env.HOME,
    terminal: {
      cols: 120,
      rows: 40,
      data(_t, bytes) {
        screen += Bun.stripANSI(new TextDecoder().decode(bytes)).replaceAll("\r", "");
        quietSince = Date.now();
      },
    },
  });
  let exited = false;
  const done = proc.exited.then((code) => {
    exited = true;
    return code;
  });
  const end = Date.now() + limitMs;
  while (!exited && Date.now() < end) {
    // Whole lines only: a chunk can end mid-code.
    for (const m of screen.matchAll(/Pairing code: (\S+)\n/g)) {
      const code = m[1] as string;
      if (approved.has(code)) continue;
      approved.add(code);
      await server.approve(code);
    }
    // Setup prints that it sent the card just before it does.
    if (!answeredCard && /Answer it on any of your devices/.test(screen)) {
      const open = await server.opened("decision", "&open=1");
      const card = open.find((d) => /^Does Starbridge reach you/.test(d.question));
      if (card) {
        answeredCard = true;
        await server.answer(card.id, { choice: card.options?.[0] ?? "Yes" });
      }
    }
    const last =
      screen
        .slice(handled)
        .split("\n")
        .filter((l) => l.trim())
        .pop() ?? "";
    // A question waits at the end of a quiet screen: `…? [Y/n]`, `…: [default]`. Quiet for
    // longer than the half second in which the pairing check takes no Enter as an answer.
    if (Date.now() - quietSince > 800 && /(\[[^\]\n]*\]|\?)\s*$/.test(last)) {
      handled = screen.length;
      const answer = answers.find(([re]) => re.test(last))?.[1] ?? "";
      steps.push({ prompt: last.trim(), answer });
      proc.terminal?.write(`${answer}\r`);
    }
    await Bun.sleep(200);
  }
  if (!exited) proc.kill("SIGKILL");
  const code = await done;
  if (code !== 0)
    console.log(`${cmd.join(" ")} exited ${code}:\n${screen}\n${JSON.stringify(steps)}`);
  return { code, screen, steps };
}

interface Owner {
  root: string;
  /** XDG_RUNTIME_DIR, where the agent's socket is. */
  runtime: string;
  home: string;
  /** The fakes' state: the agent's pid, whether its unit is enabled, lingering. */
  state: string;
  env: Record<string, string>;
  server: LiveServer;
  /** HOME before Starbridge. */
  before: Snapshot;
}
const owners: Owner[] = [];

/** A throwaway owner: HOME with their own files, private runtime dir, the fakes on the PATH. */
function newOwner(server: LiveServer, releases: string): Owner {
  const root = mkdtempSync(join(tmpdir(), "starbridge-walk-"));
  // HOME through a symbolic link, as /var is on macOS and some home folders are (#2134).
  mkdirSync(join(root, "real-home"));
  symlinkSync(join(root, "real-home"), join(root, "home"));
  const home = join(root, "home", "walker");
  // Short: a unix socket's path must fit in 104 bytes on macOS, whose temp folder is long.
  const runtime = mkdtempSync("/tmp/sbw-");
  const state = join(root, "fake-state");
  for (const d of [home, runtime, state]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // Folders every Mac has, which launchd's plist and log go in.
  if (!LINUX)
    for (const d of ["Library/LaunchAgents", "Library/Logs"])
      mkdirSync(join(home, d), { recursive: true });
  for (const [path, text] of Object.entries(OWNER_FILES)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  const env: Record<string, string> = {
    HOME: home,
    USER: "walker",
    LOGNAME: "walker",
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    // The walk's systemctl and loginctl first, then the fake agents, then bun and the system.
    PATH: [
      WALK_BIN,
      FAKE_BIN,
      dirname(process.execPath),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    XDG_RUNTIME_DIR: runtime,
    FAKE_LOG: join(state, "log"),
    FAKE_STATE: state,
    STARBRIDGE_RELEASES_URL: releases,
    // Setup's fetch of the Pi package from GitHub fails at once, as offline: Pi then clones it.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.file:///nonexistent/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://github.com/",
    // npm's own cache and Bun's stay out of HOME: they are npm's and Bun's, not Starbridge's.
    npm_config_cache: join(root, "npm-cache"),
    BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  const owner = { root, runtime, home, state, env, server, before: snapshot(home) };
  owners.push(owner);
  return owner;
}

/** The agent the walk's systemctl started, if it still runs. */
function agentRunning(o: Owner): boolean {
  const file = join(o.state, "agent.pid");
  if (!existsSync(file)) return false;
  try {
    process.kill(Number(readFileSync(file, "utf8")), 0);
    return true;
  } catch {
    return false;
  }
}

/** Setup's checks once it ran: paired, in each agent, the agent up, the test card answered. */
function expectSetUp(
  o: Owner,
  setup: { code: number | null; screen: string; steps: Step[] },
  permissions = false,
) {
  const out = setup.screen;
  expect(out).toContain("Starbridge is set up.");
  expect(out).toContain("✓ You answered Yes");
  // The agent the service started answers on its socket.
  expect(out).not.toContain("The agent did not answer yet");
  expect(out).not.toContain("✗");
  // Setup let the starbridge commands through pi-permission-system (#2130).
  expect(out).toContain('named Starbridge in "authorizerChain"');
  for (const agent of ["Claude Code", "Codex", "Pi", "opencode", "Cursor", "Antigravity"])
    expect(out).toMatch(new RegExp(`✓ ${agent}\\b`));
  expect(agentRunning(o)).toBe(true);
  if (LINUX) expect(readFileSync(join(o.state, "linger"), "utf8").trim()).toBe("yes");
  // Asked once (#2111): Enter keeps permission prompts off, y turns them on.
  expect(setup.steps.map((s) => s.prompt)).toContain(
    "Send permission prompts to your devices? [y/N]",
  );
  expect(out).toContain(
    permissions
      ? "✓ Sends permission prompts to your devices"
      : "– Permission prompts stay in the terminal",
  );
}

/**
 * Uninstall, answering yes to deleting the keys, then `after` (an npm uninstall), and nothing of
 * Starbridge is left: no service, no lingering, nothing in HOME past `theirs`, the installer's
 * own, and `known`, found and not fixed yet.
 */
async function expectUninstalled(
  o: Owner,
  bin: string,
  { after = () => {}, theirs = [] as string[], known = [] as string[] } = {},
) {
  const r = await onTerminal(o.server, [bin, "uninstall"], o.env, [[/^Delete /, "y"]]);
  expect(r.code).toBe(0);
  expect(r.screen).toContain("Stopped and removed the agent service.");
  after();
  expect(agentRunning(o)).toBe(false);
  if (LINUX) {
    expect(existsSync(join(o.state, "enabled"))).toBe(false);
    expect(readFileSync(join(o.state, "linger"), "utf8").trim()).toBe("no");
  }
  expect(leftovers(o.before, snapshot(o.home), theirs)).toEqual({
    left: [...KNOWN.left, ...known].sort(),
    changed: KNOWN.changed,
  });
  return r;
}

// Windows installs with install.ps1, and has no pty for the walk.
describe.skipIf(!LINUX && process.platform !== "darwin")("a new user's walk", () => {
  let server: LiveServer;
  let releases: ReturnType<typeof Bun.serve>;
  let releasesUrl: string;
  let installSh: string;
  let tarball: string;
  let dist: string;

  beforeAll(async () => {
    server = await LiveServer.start();
    dist = mkdtempSync(join(tmpdir(), "starbridge-walk-release-"));
    const asset = platformAsset();
    const built = Bun.spawnSync([
      process.execPath,
      "build",
      join(CLI, "src/main.ts"),
      "--compile",
      "--outfile",
      join(dist, asset),
    ]);
    if (built.exitCode !== 0) throw new Error(built.stderr.toString());
    const binary = readFileSync(join(dist, asset));
    const key = signer();
    const sums = `${createHash("sha256").update(binary).digest("hex")}  ${asset}\n`;
    const files: Record<string, Uint8Array<ArrayBuffer>> = {
      SHA256SUMS: Buffer.from(sums),
      "SHA256SUMS.minisig": Buffer.from(key.sign(Buffer.from(sums), `starbridge v${VERSION}`)),
      [asset]: binary,
    };
    releases = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/releases/latest")
          return new Response(null, {
            status: 302,
            headers: { location: `/releases/tag/v${VERSION}` },
          });
        const m = /^\/releases\/download\/v[^/]+\/(.+)$/.exec(path);
        const body = m && files[m[1] as string];
        return body ? new Response(body) : new Response("not found", { status: 404 });
      },
    });
    releasesUrl = `http://127.0.0.1:${releases.port}/releases`;
    // As the server serves it: its own address, and here the throwaway key.
    installSh = join(dist, "install.sh");
    writeFileSync(
      installSh,
      readFileSync(join(CLI, "install.sh"), "utf8")
        .replace(/^PUBKEY=\S+$/m, `PUBKEY=${key.pubkey}`)
        .replace(/^SERVER=$/m, `SERVER=${server.url}`),
    );
    const packed = Bun.spawnSync(["npm", "pack", "--pack-destination", dist], {
      cwd: CLI,
      env: { ...process.env, npm_config_cache: join(dist, "npm-cache") },
    });
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
    tarball = join(dist, packed.stdout.toString().trim().split("\n").pop() as string);
  }, 120_000);

  afterAll(() => {
    // An agent a failed walk left running.
    for (const o of owners)
      if (agentRunning(o)) process.kill(Number(readFileSync(join(o.state, "agent.pid"), "utf8")));
    server?.stop();
    releases?.stop(true);
    // Each holds a compiled binary of about 100 MB.
    for (const dir of [dist, ...owners.flatMap((o) => [o.root, o.runtime])])
      if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("curl | sh, setup, the first card, uninstall", async () => {
    const o = newOwner(server, releasesUrl);
    // `curl … | sh`: the script on stdin, the terminal on /dev/tty.
    const install = await onTerminal(server, ["sh", "-c", 'sh <"$0"', installSh], o.env);
    expect(install.code).toBe(0);
    expect(install.screen).toContain(`Installed starbridge ${VERSION}`);
    // Setup's PATH step is the one instruction for the PATH (#2116).
    expect(install.screen).not.toContain("for example in ~/.profile");
    expectSetUp(o, install);
    await expectUninstalled(o, join(o.home, ".local/bin/starbridge"));
  }, 180_000);

  test("without a terminal, install.sh names the command that runs setup (#2116)", async () => {
    const o = newOwner(server, releasesUrl);
    const run = async (env: Record<string, string>) => {
      const r = Bun.spawn(["sh", installSh], { env, cwd: o.home, stdin: "ignore", stdout: "pipe" });
      const [out] = await Promise.all([new Response(r.stdout).text(), r.exited]);
      expect(out).not.toContain("to your PATH");
      return /^Next: run (.+) setup --server (\S+)$/m.exec(out);
    };
    const next = await run(o.env);
    expect(next?.[1]).toBe(join(o.home, ".local/bin/starbridge"));
    expect(next?.[2]).toBe(server.url);
    // A folder with a space and a quote: the command still runs as printed.
    const dir = join(o.home, "my bin's");
    const quoted = await run({ ...o.env, STARBRIDGE_INSTALL_DIR: dir });
    const ran = Bun.spawnSync(["sh", "-c", `${quoted?.[1]} --version`], { env: o.env });
    expect(ran.stdout.toString()).toBe(`starbridge ${VERSION}\n`);
    // A backslash too: dash's echo would read `\n` in it.
    const odd = await run({ ...o.env, STARBRIDGE_INSTALL_DIR: join(o.home, "my\\newbin") });
    expect(Bun.spawnSync(["sh", "-c", `${odd?.[1]} --version`], { env: o.env }).exitCode).toBe(0);
    // On the PATH already, it is just `starbridge`.
    const onPath = await run({ ...o.env, PATH: `${join(o.home, ".local/bin")}:${o.env.PATH}` });
    expect(onPath?.[1]).toBe("starbridge");
    // With no setup to follow, the PATH hint stays.
    const r = Bun.spawn(["sh", installSh], {
      env: { ...o.env, STARBRIDGE_NO_SETUP: "1" },
      stdin: "ignore",
      stdout: "pipe",
    });
    const [out] = await Promise.all([new Response(r.stdout).text(), r.exited]);
    expect(out).toContain(`Add ${join(o.home, ".local/bin")} to your PATH`);
  }, 60_000);

  test("npm i -g, setup, the first card, uninstall, npm rm -g", async () => {
    const o = newOwner(server, releasesUrl);
    const prefix = join(o.home, ".npm-global");
    o.env.npm_config_prefix = prefix;
    o.env.PATH = `${join(prefix, "bin")}:${o.env.PATH}`;
    // npm and the package run on Node.
    const node = Bun.which("node");
    if (node) o.env.PATH = `${o.env.PATH}:${dirname(node)}`;
    mkdirSync(prefix);
    o.before = snapshot(o.home);
    const npm = (args: string[]) =>
      Bun.spawnSync(["npm", ...args], { env: o.env, cwd: o.home, stdout: "pipe", stderr: "pipe" });
    const installed = npm(["install", "-g", tarball]);
    expect(installed.stderr.toString()).not.toContain("ERR");
    expect(installed.exitCode).toBe(0);
    const setup = await onTerminal(server, ["starbridge", "setup", "--server", server.url], o.env, [
      [/Send permission prompts/, "y"],
    ]);
    expect(setup.code).toBe(0);
    expectSetUp(o, setup, true);
    const config = Bun.spawnSync(["starbridge", "config"], { env: o.env, cwd: o.home });
    expect(config.stdout.toString()).toMatch(/^permissions +on$/m);
    // A second setup keeps the answer and asks nothing about it.
    const again = await onTerminal(server, ["starbridge", "setup"], o.env);
    expect(again.code).toBe(0);
    expect(again.steps.map((s) => s.prompt).join("\n")).not.toContain("permission prompts");
    const r = await expectUninstalled(o, "starbridge", {
      after: () => expect(npm(["rm", "-g", "starbridge"]).exitCode).toBe(0),
      // npm's own folders in its prefix stay, as after any global package.
      theirs: [".npm-global/bin", ".npm-global/lib", ".npm-global/lib/node_modules"],
    });
    expect(r.screen).toContain("npm rm -g starbridge");
  }, 180_000);
});
