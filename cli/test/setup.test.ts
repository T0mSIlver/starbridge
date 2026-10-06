import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
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
import { dirname, join, relative, resolve } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { makeAgent } from "../src/agent/main";
import type { Agent } from "../src/agent/server";
import { REMOVED } from "../src/api";
import { installTarball, updateCodexbar } from "../src/setup/codexbar";
import { installOpencode, opencodeState, PI_PACKAGE, removeOpencode } from "../src/setup/harnesses";
import opencodeFiles from "../src/setup/opencode-files.js";
import { setup } from "../src/setup/setup";
import { status } from "../src/setup/status";
import { defaults, failure, type Sys } from "../src/setup/sys";
import { uninstall } from "../src/setup/uninstall";
import { paired, type TestCtx, testCtx, until } from "./helpers";

setDefaultTimeout(30_000);

const FAKE_BIN = join(import.meta.dir, "fixtures", "fake-bin");
const SELF = "/opt/starbridge/bin/starbridge";

let server: LiveServer;
let agents: Agent[];
beforeEach(async () => {
  server = await LiveServer.start();
  agents = [];
});
afterEach(async () => {
  for (const a of agents) await a.stop();
  server.stop();
});

/**
 * A paired machine in a throwaway HOME, with fake systemctl, loginctl, claude and codexbar on
 * the PATH.
 */
async function machine() {
  const ctx = await paired(server);
  const home = mkdtempSync(join(tmpdir(), "starbridge-home-"));
  const log = join(home, "calls.log");
  Object.assign(ctx.env, {
    HOME: home,
    // The fake claude runs bun, which CI does not keep in /usr/bin.
    PATH: `${FAKE_BIN}:${dirname(process.execPath)}:/usr/bin:/bin`,
    USER: "dev",
    FAKE_LOG: log,
    FAKE_STATE: join(home, "fake-state"),
  });
  const units = join(home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  const settings = join(home, ".claude/settings.json");
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ model: "opus" }));
  const sys: Sys = {
    ctx,
    home,
    platform: "linux",
    arch: "x64",
    uid: 1000,
    prompt: defaults,
    self: [SELF],
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { ctx, sys, home, units, settings, calls };
}

/** Starts the agent in-process, as the fake systemctl's `restart` would. */
async function startAgent(ctx: TestCtx) {
  const agent = makeAgent(ctx);
  await agent.start();
  agents.push(agent);
  // An earlier setup's providers, which setup checks again; the agent started without them.
  ctx.store.saveAgentConfig({ quota: { providers: ["codex", "zai"], interval: "5m" } });
}

test("setup --yes installs the agent, the plugins and the skills, and uploads a first snapshot", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  // An earlier setup's providers: two still work, two now need a sign-in.
  m.ctx.store.saveAgentConfig({
    quota: { providers: ["codex", "zai", "broken", "signedout"], interval: "5m" },
  });
  expect(await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 })).toBe(0);
  const out = m.ctx.lines.join("\n");

  // Providers: the earlier ones that work now; `broken` needs a sign-in and is left out.
  expect(out).toContain("needs sign-in: No available fetch strategy for signedout.");
  expect(out).toContain("needs sign-in: Error: provider not configured");
  expect(m.ctx.store.agentConfig().quota).toEqual({
    providers: ["codex", "zai"],
    codexbar: join(FAKE_BIN, "codexbar"),
    interval: "5m",
  });

  const unit = readFileSync(join(m.units, "starbridge-agent.service"), "utf8");
  expect(unit).toContain(`ExecStart=${SELF} agent`);
  expect(unit).toContain("Environment=PATH=");
  const sd = m.calls().filter((c) => c.startsWith("systemctl"));
  expect(sd).toContain("systemctl --user enable starbridge-agent.service");

  // Plugins from the marketplace, auto-updated, with the allow rules.
  expect(m.calls()).toContain("claude plugin marketplace add T0mSIlver/starbridge");
  expect(m.calls()).toContain("claude plugin install starbridge@starbridge --scope user");
  expect(m.calls()).toContain("claude plugin install starbridge-mod@starbridge --scope user");
  const settings = JSON.parse(readFileSync(m.settings, "utf8"));
  expect(settings.model).toBe("opus");
  expect(settings.extraKnownMarketplaces.starbridge.autoUpdate).toBe(true);
  expect(settings.permissions.allow).toContain("Bash(starbridge ask:*)");

  // Codex gets the skill this CLI carries; Pi gets the Starbridge package.
  const skill = readFileSync(join(m.home, ".codex/skills/starbridge/SKILL.md"), "utf8");
  expect(skill).toBe(
    readFileSync(join(import.meta.dir, "../../plugin/skills/starbridge/SKILL.md"), "utf8"),
  );
  expect(m.calls()).toContain(`pi install ${PI_PACKAGE}`);
  expect(readFileSync(join(m.home, ".codex/rules/starbridge.rules"), "utf8")).toContain(
    '"starbridge", ["ask"',
  );
  // opencode gets the skill and the plugin with the code it imports, in the repository's layout.
  const oc = join(m.home, ".config/opencode");
  expect(readFileSync(join(oc, "skills/starbridge/SKILL.md"), "utf8")).toBe(skill);
  expect(readFileSync(join(oc, "plugins/starbridge.ts"), "utf8")).toContain(
    'from "../starbridge/mod/opencode/starbridge.ts"',
  );
  for (const f of ["mod/opencode/starbridge.ts", "mod/hooks/node.ts", "plugin/hooks/rule.md"])
    expect(readFileSync(join(oc, "starbridge", f), "utf8")).toBe(
      readFileSync(join(import.meta.dir, "../..", f), "utf8"),
    );

  const [snap] = await server.opened("quota");
  expect(snap?.providers.map((p) => p.provider)).toEqual(["codex", "zai"]);
  expect(out).toContain("Uploaded a first quota snapshot: 2 providers");
  // --yes sends no test decision: nobody is there to answer it.
  expect(await server.opened("decision")).toEqual([]);
});

test("a second setup changes nothing", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 });
  const unit = readFileSync(join(m.units, "starbridge-agent.service"), "utf8");
  const before = m.calls().length;
  m.ctx.lines.length = 0;
  await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 });
  const again = m.calls().slice(before);
  expect(
    again.filter((c) => /install|marketplace add|disable|restart|daemon-reload/.test(c)),
  ).toEqual([]);
  expect(readFileSync(join(m.units, "starbridge-agent.service"), "utf8")).toBe(unit);
  expect(m.ctx.store.agentConfig().quota?.providers).toEqual(["codex", "zai"]);
  expect(m.ctx.lines.join("\n")).toContain("plugins are installed");

  // A Codex skill from an older CLI is offered as an update.
  writeFileSync(
    join(m.home, ".codex/skills/starbridge/SKILL.md"),
    "---\nname: starbridge\n---\nold\n",
  );
  const asked: string[] = [];
  await setup(
    {
      ...m.sys,
      prompt: {
        ...m.sys.prompt,
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      },
    },
    { readyTimeoutMs: 2_000 },
  );
  expect(asked).toContain(
    `Update the Starbridge skill for Codex in ${join(m.home, ".codex/skills/starbridge")}?`,
  );
  // Declined: nothing written.
  expect(readFileSync(join(m.home, ".codex/skills/starbridge/SKILL.md"), "utf8")).toContain("old");

  // A Pi package at another release moves to this CLI's tag.
  const pi = join(m.home, ".pi/agent/settings.json");
  writeFileSync(pi, JSON.stringify({ packages: ["git:github.com/T0mSIlver/starbridge@v0.9.0"] }));
  await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 });
  expect(JSON.parse(readFileSync(pi, "utf8")).packages).toEqual([PI_PACKAGE]);
});

test("status reports the agent, the service and the plugins", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 });
  m.ctx.lines.length = 0;
  expect(await status(m.sys)).toBe(0);
  const out = m.ctx.lines.join("\n");
  expect(out).toContain('Paired: "devbox"');
  expect(out).toMatch(/Agent: \S+, pid \d+/);
  expect(out).toContain("Server: reachable");
  expect(out).toContain("Service: active, enabled");
  expect(out).toContain("starbridge-mod@starbridge: 0.2.0");
  expect(out).toContain("Codex skill: installed");
  expect(out).toContain("Pi package: installed");
  expect(out).toContain("opencode skill and plugin: installed");
});

test("status says at once that the owner removed this machine, and how to pair it again", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  await until(async () => {
    m.ctx.lines.length = 0;
    await status(m.sys);
    return m.ctx.lines.join("\n").includes("Server: reachable");
  });
  await server.revoke(m.ctx.store.machine()?.id as string);
  // Within the agent's first backoff, long before its 60 s poll would have ended.
  await until(async () => {
    m.ctx.lines.length = 0;
    await status(m.sys);
    return m.ctx.lines.join("\n").includes(REMOVED);
  }, 3_000);
  expect(m.ctx.lines).toContain(`Server: reachable, but ${REMOVED}`);
});

test("uninstall removes the service and plugins, asks the devices to revoke, keeps the keys", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  // pi-permission-system with the owner's own policy, the link `config permissions on` adds,
  // and a bash pattern setup added before #488.
  const pps = join(m.home, ".pi/agent/extensions/pi-permission-system/config.json");
  mkdirSync(dirname(pps), { recursive: true });
  const bash = { "*": "ask", "starbridge ask *": "allow" };
  writeFileSync(
    pps,
    JSON.stringify({ permission: { bash }, authorizerChain: ["judge", "starbridge"] }),
  );
  await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 });
  // The link lets the starbridge commands through; no bash pattern does (#488).
  const permission = JSON.parse(readFileSync(pps, "utf8")).permission;
  expect(permission.bash).toEqual({ "*": "ask" });
  expect(permission.skill).toEqual({ starbridge: "allow" });
  m.ctx.lines.length = 0;
  expect(await uninstall(m.sys, {})).toBe(0);
  expect(existsSync(join(m.units, "starbridge-agent.service"))).toBe(false);
  expect(m.calls()).toContain("systemctl --user disable --now starbridge-agent.service");
  expect(m.calls()).toContain("claude plugin uninstall starbridge-mod@starbridge --scope user");
  expect(m.calls()).toContain("claude plugin marketplace remove starbridge");
  expect(
    JSON.parse(readFileSync(join(m.home, ".claude/settings.json"), "utf8")).permissions.allow,
  ).toEqual([]);
  expect(existsSync(join(m.home, ".codex/skills/starbridge"))).toBe(false);
  expect(existsSync(join(m.home, ".codex/rules/starbridge.rules"))).toBe(false);
  expect(m.calls()).toContain(`pi remove ${PI_PACKAGE}`);
  expect(readdirSync(join(m.home, ".config/opencode")).sort()).toEqual(["plugins", "skills"]);
  expect(readdirSync(join(m.home, ".config/opencode/plugins"))).toEqual([]);
  expect(JSON.parse(readFileSync(pps, "utf8"))).toEqual({
    permission: { bash: { "*": "ask" } },
    authorizerChain: ["judge"],
  });
  const [d] = await server.opened("decision");
  expect(d?.question).toBe("Revoke devbox? It was uninstalled.");
  expect(existsSync(join(m.ctx.store.dir, "machine.json"))).toBe(true);

  expect(await uninstall(m.sys, { purge: true })).toBe(0);
  expect(existsSync(m.ctx.store.dir)).toBe(false);
});

test("setup without a user systemd keeps going and says how to run the agent", async () => {
  const m = await machine();
  m.ctx.env.PATH = `${join(m.home, "bin")}:${m.ctx.env.PATH}`;
  mkdirSync(join(m.home, "bin"));
  writeFileSync(
    join(m.home, "bin/systemctl"),
    "#!/bin/sh\necho 'Failed to connect to bus' >&2\nexit 1\n",
    {
      mode: 0o755,
    },
  );
  expect(await setup(m.sys, { yes: true, noPlugin: true, readyTimeoutMs: 500 })).toBe(0);
  const out = m.ctx.lines.join("\n");
  expect(out).toContain("no systemd user manager (Failed to connect to bus)");
  expect(existsSync(join(m.units, "starbridge-agent.service"))).toBe(false);
  // No agent: the first upload goes to the server directly.
  expect((await server.opened("quota")).length).toBe(1);
});

/**
 * CodexBar's releases as GitHub serves them: the API's latest tag, and each version's tarball
 * with a `.sha256` beside it, which `sums` replaces or, when null, leaves out.
 */
function fakeCodexbarReleases(latest: string, sums: (v: string, sha: string) => string | null) {
  const tarball = (v: string) => {
    const src = mkdtempSync(join(tmpdir(), "codexbar-src-"));
    writeFileSync(join(src, "CodexBarCLI"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(src, "VERSION"), `${v}\n`);
    symlinkSync("CodexBarCLI", join(src, "codexbar"));
    return new Uint8Array(Bun.spawnSync(["tar", "-czf", "-", "-C", src, "."]).stdout);
  };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/latest") return Response.json({ tag_name: `v${latest}` });
      const m = /^\/dl\/v([^/]+)\/CodexBarCLI-v[^/]+-linux-x86_64\.tar\.gz(\.sha256)?$/.exec(path);
      if (!m) return new Response("not found", { status: 404 });
      const bytes = tarball(m[1] as string);
      if (!m[2]) return new Response(bytes);
      const text = sums(m[1] as string, createHash("sha256").update(bytes).digest("hex"));
      return text === null ? new Response("not found", { status: 404 }) : new Response(text);
    },
  });
  const env = {
    PATH: "/usr/bin:/bin",
    STARBRIDGE_CODEXBAR_API: `${server.url.href}api`,
    STARBRIDGE_CODEXBAR_RELEASES: `${server.url.href}dl`,
  };
  return { server, env };
}

function linuxSys(ctx: TestCtx, home: string): Sys {
  return { ctx, home, platform: "linux", arch: "x64", uid: 1000, prompt: defaults, self: [SELF] };
}

test("CodexBar installs only when its release's own checksum matches", async () => {
  const home = mkdtempSync(join(tmpdir(), "starbridge-home-"));
  const opt = join(home, ".local/opt/codexbar");
  let sums: string | null = null;
  const fake = fakeCodexbarReleases("9.9.9", () => sums);
  try {
    const sys = linuxSys(testCtx(fake.env), home);
    await expect(installTarball(sys, "linux-x86_64", "9.9.9")).rejects.toThrow("no checksum");
    sums = `${"0".repeat(64)}  CodexBarCLI-v9.9.9-linux-x86_64.tar.gz\n`;
    await expect(installTarball(sys, "linux-x86_64", "9.9.9")).rejects.toThrow("not installed");
    expect(existsSync(opt)).toBe(false);
  } finally {
    fake.server.stop();
  }
});

test("update moves setup's CodexBar to the latest release, or the one named", async () => {
  const home = mkdtempSync(join(tmpdir(), "starbridge-home-"));
  const fake = fakeCodexbarReleases(
    "9.9.9",
    (v, sha) => `${sha}  CodexBarCLI-v${v}-linux-x86_64.tar.gz\n`,
  );
  try {
    const ctx = testCtx(fake.env);
    const sys = linuxSys(ctx, home);
    const path = await installTarball(sys, "linux-x86_64", "9.9.8");
    expect(path).toBe(join(home, ".local/opt/codexbar/codexbar"));
    expect(await updateCodexbar(sys, undefined)).toBe(0);
    expect(await updateCodexbar(sys, undefined)).toBe(0);
    expect(await updateCodexbar(sys, undefined, "v9.9.7")).toBe(0);
    expect(ctx.lines).toEqual([
      "Downloading CodexBar 9.9.9 (linux-x86_64)",
      `Installed CodexBar 9.9.9 to ${join(home, ".local/opt/codexbar")}, linked as ${join(home, ".local/bin/codexbar")}.`,
      "CodexBar 9.9.9 is up to date.",
      "Downloading CodexBar 9.9.7 (linux-x86_64)",
      `Installed CodexBar 9.9.7 to ${join(home, ".local/opt/codexbar")}, linked as ${join(home, ".local/bin/codexbar")}.`,
    ]);
    expect(readlinkSync(join(home, ".local/bin/codexbar"))).toBe(path);

    const brew = join(home, "brew/codexbar");
    mkdirSync(dirname(brew));
    writeFileSync(brew, "#!/bin/sh\n", { mode: 0o755 });
    expect(await updateCodexbar(sys, brew)).toBe(0);
    expect(ctx.lines.at(-1)).toContain(`CodexBar at ${brew} was not installed by starbridge`);
  } finally {
    fake.server.stop();
  }
});

test("uninstall keeps the keys when systemd cannot stop the agent", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 });
  m.ctx.env.PATH = `${join(m.home, "bin")}:${m.ctx.env.PATH}`;
  mkdirSync(join(m.home, "bin"));
  writeFileSync(
    join(m.home, "bin/systemctl"),
    "#!/bin/sh\necho 'Failed to connect to bus' >&2\nexit 1\n",
    {
      mode: 0o755,
    },
  );
  expect(await uninstall(m.sys, { purge: true })).toBe(1);
  expect(m.ctx.lines.join("\n")).toContain("Could not stop the agent service, so it stays");
  expect(existsSync(join(m.units, "starbridge-agent.service"))).toBe(true);
  expect(existsSync(join(m.ctx.store.dir, "machine.json"))).toBe(true);
});

test("a failed command reports the reason from stderr, not the progress on stdout", () => {
  // `claude plugin marketplace add` on a machine that cannot clone the repo.
  const r = {
    code: 1,
    stdout: "Adding marketplace…\n",
    stderr:
      "✘ Failed to add marketplace: Fetching the marketplace from GitHub failed on both attempts.\nfatal: unable to get password from user\n\nPlease make sure you have the correct access rights\n",
  };
  expect(failure(r)).toBe(
    "✘ Failed to add marketplace: Fetching the marketplace from GitHub failed on both attempts.",
  );
  expect(failure({ code: 3, stdout: "a\nlast\n", stderr: "" })).toBe("last");
});

test("setup installs no plugin from a marketplace named starbridge that is not this repository", async () => {
  const m = await machine();
  mkdirSync(m.ctx.env.FAKE_STATE as string, { recursive: true });
  writeFileSync(join(m.ctx.env.FAKE_STATE as string, "market"), "");
  m.ctx.env.FAKE_MARKET_REPO = "someone/starbridge";
  await startAgent(m.ctx);
  expect(await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 })).toBe(0);
  expect(m.calls().filter((c) => c.startsWith("claude plugin install"))).toEqual([]);
  expect(m.ctx.lines.join("\n")).toContain(
    "comes from someone/starbridge, not T0mSIlver/starbridge",
  );
});

test("setup ships every file the opencode plugin imports", () => {
  const root = join(import.meta.dir, "../..");
  const need = new Set<string>();
  const walk = (path: string) => {
    if (need.has(path)) return;
    need.add(path);
    const text = readFileSync(join(root, path), "utf8");
    for (const [, spec] of text.matchAll(/from "(\.{1,2}\/[^"]+)"/g))
      walk(relative(root, resolve(dirname(join(root, path)), spec as string)));
  };
  walk("mod/opencode/starbridge.ts");
  expect([...need].sort()).toEqual(Object.keys(opencodeFiles).sort());
});

test("opencode files someone else wrote stay, and so does the code a changed entry loads", () => {
  const home = mkdtempSync(join(tmpdir(), "starbridge-oc-"));
  const sys = { ctx: testCtx({ HOME: home }), home };
  const oc = join(home, ".config/opencode");
  mkdirSync(join(oc, "plugins"), { recursive: true });
  writeFileSync(join(oc, "plugins/starbridge.ts"), "// mine\n");
  // The skill installs; the foreign entry and the code it would load do not.
  expect(installOpencode(sys)).toEqual([join(oc, "plugins/starbridge.ts")]);
  expect(readFileSync(join(oc, "plugins/starbridge.ts"), "utf8")).toBe("// mine\n");
  expect(existsSync(join(oc, "starbridge"))).toBe(false);
  expect(existsSync(join(oc, "skills/starbridge/SKILL.md"))).toBe(true);
  // The agent's update leaves them alone too.
  expect(opencodeState(sys)).toBe("outdated");
  installOpencode(sys, true);
  expect(readFileSync(join(oc, "plugins/starbridge.ts"), "utf8")).toBe("// mine\n");

  // An entry setup wrote and the owner edited keeps its code at uninstall.
  rmSync(join(oc, "plugins/starbridge.ts"));
  installOpencode(sys);
  const entry = readFileSync(join(oc, "plugins/starbridge.ts"), "utf8");
  writeFileSync(join(oc, "plugins/starbridge.ts"), `${entry}// tweaked\n`);
  removeOpencode(sys);
  expect(existsSync(join(oc, "starbridge/mod/opencode/starbridge.ts"))).toBe(true);
  expect(existsSync(join(oc, "skills/starbridge"))).toBe(false);
});
