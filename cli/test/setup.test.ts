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
import { run } from "../src/cli";
import { session } from "../src/context";
import { poll } from "../src/decisions";
import { installTarball, updateCodexbar } from "../src/setup/codexbar";
import {
  CODEX_RULE,
  installOpencode,
  opencodeState,
  PI_PACKAGE,
  removeOpencode,
} from "../src/setup/harnesses";
import { markedSkill } from "../src/setup/marker";
import opencodeFiles from "../src/setup/opencode-files.js";
import { withInstalledPlaces } from "../src/setup/service";
import { refresh, setup } from "../src/setup/setup";
import { status } from "../src/setup/status";
import { defaults, failure, type Sys } from "../src/setup/sys";
import { uninstall } from "../src/setup/uninstall";
import { VERSION } from "../src/version";
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
    // SELF's folder too, so setup's PATH step has nothing to add.
    PATH: `${FAKE_BIN}:${dirname(SELF)}:${dirname(process.execPath)}:/usr/bin:/bin`,
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
    markedSkill(
      readFileSync(join(import.meta.dir, "../../plugin/skills/starbridge/SKILL.md"), "utf8"),
    ),
  );
  expect(skill.split("\n")[1]).toBe(
    `# Written by starbridge ${VERSION}; \`starbridge uninstall\` removes it.`,
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
    "---\n# Written by starbridge 0.9.0; `starbridge uninstall` removes it.\nname: starbridge\n---\nold\n",
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

test("refresh brings what setup wrote to this release and leaves the rest alone", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 });
  const rule = join(m.home, ".codex/rules/starbridge.rules");
  const skill = join(m.home, ".codex/skills/starbridge/SKILL.md");
  const entry = join(m.home, ".config/opencode/plugins/starbridge.ts");
  const unit = join(m.units, "starbridge-agent.service");
  const want = readFileSync(unit, "utf8");
  // As an earlier release wrote them, with its markers; the skill, unmarked, is a copy another
  // skill manager put there.
  writeFileSync(rule, "# Written by starbridge setup: questions need the network.\nold\n");
  writeFileSync(entry, "// Written by starbridge setup: answers.\nold\n");
  writeFileSync(unit, "# Written by `starbridge setup`; `starbridge uninstall` removes it.\nold\n");
  writeFileSync(skill, "---\nname: starbridge\n---\nmine\n");
  const done = await refresh(m.sys);
  expect(readFileSync(rule, "utf8")).toBe(CODEX_RULE);
  expect(readFileSync(entry, "utf8")).toStartWith(`// Written by starbridge ${VERSION};`);
  expect(readFileSync(unit, "utf8")).toBe(want);
  expect(readFileSync(skill, "utf8")).toBe("---\nname: starbridge\n---\nmine\n");
  expect(done.some((l) => l.startsWith("Restarted the agent"))).toBe(true);
  // Again: nothing to update; the agent restarts on the binary that runs it.
  expect(await refresh(m.sys)).toEqual([`Restarted the agent (${unit}).`]);
});

test("setup leaves a Codex rule, a skill or a unit it did not write alone", async () => {
  const m = await machine();
  const rule = join(m.home, ".codex/rules/starbridge.rules");
  const skill = join(m.home, ".codex/skills/starbridge/SKILL.md");
  const unit = join(m.units, "starbridge-agent.service");
  mkdirSync(dirname(rule), { recursive: true });
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(rule, "# mine\n");
  writeFileSync(skill, "---\nname: starbridge\n---\nmine\n");
  writeFileSync(unit, "[Service]\nExecStart=/usr/bin/true\n");
  await setup(m.sys, { yes: true, readyTimeoutMs: 500 });
  const out = m.ctx.lines.join("\n");
  expect(readFileSync(rule, "utf8")).toBe("# mine\n");
  expect(readFileSync(skill, "utf8")).toBe("---\nname: starbridge\n---\nmine\n");
  expect(readFileSync(unit, "utf8")).toBe("[Service]\nExecStart=/usr/bin/true\n");
  expect(out).toContain("was not written by setup");
  expect(await refresh(m.sys)).toEqual([]);
  await uninstall(m.sys, {});
  expect(existsSync(rule) && existsSync(skill) && existsSync(unit)).toBe(true);
});

test("a refresh keeps the places the installed unit points the agent at", () => {
  const unit = `${"# Written by starbridge 1.0.0"}\nEnvironment=PATH=/usr/bin\nEnvironment="STARBRIDGE_CONFIG_DIR=/srv/a b"\nEnvironment=CODEX_HOME=/c\n`;
  expect(
    withInstalledPlaces({ PATH: "/x", CODEX_HOME: "/other", XDG_CONFIG_HOME: "/y" }, unit),
  ).toEqual({
    PATH: "/x",
    STARBRIDGE_CONFIG_DIR: "/srv/a b",
    CODEX_HOME: "/c",
  });
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

test("status lists the answers no session has taken, until a wait prints them (#557)", async () => {
  const m = await machine();
  const ask = ["ask", "--question", "Merge #12?", "--option", "Merge", "--option", "Wait"];
  expect(await run([...ask, "--session", "s1"], m.ctx)).toBe(0);
  const id = m.ctx.lines.at(-1) as string;
  await server.answer(id, { choice: "Merge" });
  // The agent's poll stores the answer; the session's wait had died.
  await poll(m.ctx, session(m.ctx), {
    cursor: m.ctx.store.state().cursor,
    seconds: 0,
    shared: true,
  });
  m.ctx.lines.length = 0;
  await status(m.sys);
  expect(m.ctx.lines).toContain("Answers no session has taken: 1");
  expect(m.ctx.lines).toContain(
    `  ${id} (Merge #12?) from session s1: \`starbridge wait ${id}\` prints it`,
  );
  expect(await run(["wait", id, "--timeout", "5s"], m.ctx)).toBe(0);
  m.ctx.lines.length = 0;
  await status(m.sys);
  expect(m.ctx.lines.join("\n")).not.toContain("no session has taken");
});

test("status lists every starbridge on the PATH, and how to remove the others (#621)", async () => {
  const m = await machine();
  const dirs = ["a", "b"].map((d) => join(m.home, d));
  for (const [i, d] of dirs.entries()) {
    mkdirSync(d);
    writeFileSync(join(d, "starbridge"), `#!/bin/sh\necho "starbridge 0.${i + 1}.0"\n`, {
      mode: 0o755,
    });
  }
  m.ctx.env.PATH = `${dirs.join(":")}:${m.ctx.env.PATH}`;
  await status({ ...m.sys, self: [join(dirs[0] as string, "starbridge")] });
  expect(m.ctx.lines.slice(1, 5)).toEqual([
    "2 copies of starbridge are on the PATH; a terminal runs the first:",
    `  ${dirs[0]}/starbridge: 0.1.0, this one`,
    `  ${dirs[1]}/starbridge: 0.2.0, delete the file to remove it`,
    "Keep one: `starbridge update` updates only the copy it runs from.",
  ]);
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

test("a failed service start says how to run the agent and that setup retries (#614)", async () => {
  const m = await machine();
  m.ctx.env.PATH = `${join(m.home, "bin")}:${m.ctx.env.PATH}`;
  mkdirSync(join(m.home, "bin"));
  writeFileSync(
    join(m.home, "bin/systemctl"),
    '#!/bin/sh\n[ "$2" = enable ] && { echo "Access denied" >&2; exit 1; }\nexit 0\n',
    { mode: 0o755 },
  );
  expect(await setup(m.sys, { yes: true, noPlugin: true, readyTimeoutMs: 500 })).toBe(0);
  const out = m.ctx.lines.join("\n");
  expect(out).toContain("Could not start the agent service");
  expect(out).toContain("Run `starbridge agent` yourself");
  expect(out).toContain("`starbridge setup` again");
});

test("an old Claude Code: setup says what failed and to update it (#620)", async () => {
  const m = await machine();
  Object.assign(m.ctx.env, { FAKE_CLAUDE_VERSION: "2.1.200", FAKE_NO_JSON: "1" });
  expect(await setup(m.sys, { yes: true, noQuota: true, noService: true })).toBe(0);
  expect(m.ctx.lines.join("\n")).toContain(
    "`claude plugin marketplace list --json` failed (error: unknown option '--json'). Claude Code 2.1.200 is older than 2.1.287, the oldest Starbridge works with: `claude update` updates it. Skipped",
  );
});

test("Ctrl-C at the test decision withdraws it from the devices (#613)", async () => {
  const m = await machine();
  const stop = new AbortController();
  m.ctx.signal = stop.signal;
  const sys: Sys = {
    ...m.sys,
    prompt: { ...m.sys.prompt, confirm: async (q) => q.startsWith("Send a test decision") },
  };
  const done = setup(sys, { noQuota: true, noPlugin: true, noService: true });
  await until(async () => (await server.opened("decision")).length === 1);
  stop.abort();
  expect(await done).toBe(0);
  expect(m.ctx.lines).toContain("Skipped.");
  const [decision] = await server.opened("decision");
  const [settled] = await server.opened("settled");
  expect(settled?.itemId).toBe(decision?.id);
  expect(settled?.outcome).toBe("withdrawn");
});

/**
 * CodexBar's releases as GitHub serves them: the API's latest tag, and each version's tarball
 * with a `.sha256` beside it, which `sums` replaces or, when null, leaves out. `latest` may
 * be changed while it serves.
 */
function fakeCodexbarReleases(latest: string, sums: (v: string, sha: string) => string | null) {
  const state = { latest };
  const tarball = (v: string) => {
    const src = mkdtempSync(join(tmpdir(), "codexbar-src-"));
    writeFileSync(join(src, "CodexBarCLI"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(src, "VERSION"), `${v}\n`);
    symlinkSync("CodexBarCLI", join(src, "codexbar"));
    return new Uint8Array(Bun.spawnSync(["tar", "-czf", "-", "-C", src, "."]).stdout);
  };
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (path === "/rel/latest")
        return Response.redirect(`${server.url.href}rel/tag/v${state.latest}`, 302);
      const m =
        /^\/rel\/download\/v([^/]+)\/CodexBarCLI-v[^/]+-linux-x86_64\.tar\.gz(\.sha256)?$/.exec(
          path,
        );
      if (!m) return new Response("not found", { status: 404 });
      const bytes = tarball(m[1] as string);
      if (!m[2]) return new Response(bytes);
      const text = sums(m[1] as string, createHash("sha256").update(bytes).digest("hex"));
      return text === null ? new Response("not found", { status: 404 }) : new Response(text);
    },
  });
  const env = {
    PATH: "/usr/bin:/bin",
    STARBRIDGE_CODEXBAR_RELEASES: `${server.url.href}rel`,
  };
  return { server, env, state };
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
    // 10.0.0 is a release whose tarballs are still uploading.
    (v, sha) => (v === "10.0.0" ? null : `${sha}  CodexBarCLI-v${v}-linux-x86_64.tar.gz\n`),
  );
  try {
    const ctx = testCtx(fake.env);
    const sys = linuxSys(ctx, home);
    const path = await installTarball(sys, "linux-x86_64", "9.9.8");
    expect(path).toBe(join(home, ".local/opt/codexbar/codexbar"));
    ctx.lines.length = 0;
    expect(await updateCodexbar(sys, undefined)).toBe(0);
    expect(await updateCodexbar(sys, undefined)).toBe(0);
    expect(await updateCodexbar(sys, undefined, "v9.9.7")).toBe(0);
    expect(ctx.lines).toEqual([
      "Downloading CodexBar 9.9.9 (linux-x86_64), 1 kB",
      `Installed CodexBar 9.9.9 to ${join(home, ".local/opt/codexbar")}, linked as ${join(home, ".local/bin/codexbar")}.`,
      "CodexBar 9.9.9 is up to date.",
      "Downloading CodexBar 9.9.7 (linux-x86_64), 1 kB",
      `Installed CodexBar 9.9.7 to ${join(home, ".local/opt/codexbar")}, linked as ${join(home, ".local/bin/codexbar")}.`,
    ]);
    expect(readlinkSync(join(home, ".local/bin/codexbar"))).toBe(path);
    fake.state.latest = "10.0.0";
    expect(await updateCodexbar(sys, undefined)).toBe(0);
    expect(ctx.lines.at(-1)).toBe(
      "CodexBar 10.0.0's build for this machine is not published yet: kept 9.9.7.",
    );

    const brew = join(home, "brew/codexbar");
    mkdirSync(dirname(brew));
    writeFileSync(brew, "#!/bin/sh\n", { mode: 0o755 });
    expect(await updateCodexbar(sys, brew)).toBe(0);
    expect(ctx.lines.at(-1)).toContain(`CodexBar at ${brew} was not installed by starbridge`);
  } finally {
    fake.server.stop();
  }
});

test("a CodexBar download says how far it got; GitHub's limit is named (#618)", async () => {
  const home = mkdtempSync(join(tmpdir(), "starbridge-home-"));
  const fake = fakeCodexbarReleases("9.9.9", (v, sha) => `${sha}  CodexBarCLI-v${v}.tar.gz\n`);
  const limited = Bun.serve({ port: 0, fetch: () => new Response("slow down", { status: 429 }) });
  try {
    const ctx = testCtx(fake.env);
    let t = 0;
    ctx.now = () => {
      t += 6_000;
      return new Date(t);
    };
    await installTarball(linuxSys(ctx, home), "linux-x86_64", "9.9.9");
    expect(ctx.lines).toEqual([
      "Downloading CodexBar 9.9.9 (linux-x86_64), 1 kB",
      "  1 kB of 1 kB",
    ]);
    // A download cut short leaves nothing behind, and says which file.
    const cut = Bun.serve({
      port: 0,
      fetch: (req) =>
        req.url.endsWith(".sha256")
          ? new Response(`${"0".repeat(64)}\n`)
          : new Response(
              new ReadableStream({
                pull(c) {
                  c.enqueue(new Uint8Array(1024));
                  c.error(new Error("connection reset"));
                },
              }),
            ),
    });
    const cutCtx = testCtx({ STARBRIDGE_CODEXBAR_RELEASES: cut.url.href.replace(/\/$/, "") });
    await expect(installTarball(linuxSys(cutCtx, home), "linux-x86_64", "9.9.8")).rejects.toThrow(
      "downloading CodexBarCLI-v9.9.8-linux-x86_64.tar.gz:",
    );
    cut.stop();
    expect(readdirSync(join(home, ".local/opt"))).toEqual(["codexbar"]);
    const offline = testCtx({ STARBRIDGE_CODEXBAR_RELEASES: limited.url.href });
    await expect(updateCodexbar(linuxSys(offline, home), undefined)).resolves.toBe(1);
    expect(offline.lines.join("\n")).toContain("GitHub is limiting requests from this address");
  } finally {
    fake.server.stop();
    limited.stop();
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
  // Status says so rather than "outdated" forever (#541), and the agent's update leaves them alone.
  expect(opencodeState(sys)).toBe("foreign");
  installOpencode(sys, true);
  expect(readFileSync(join(oc, "plugins/starbridge.ts"), "utf8")).toBe("// mine\n");
  // A setup skill gone stale still reads as outdated beside the foreign entry.
  writeFileSync(join(oc, "skills/starbridge/SKILL.md"), "# Written by starbridge 0.0.1\n");
  expect(opencodeState(sys)).toBe("outdated");
  // Someone else's skill beside a current plugin: the same.
  rmSync(join(oc, "plugins/starbridge.ts"));
  rmSync(join(oc, "skills/starbridge/SKILL.md"));
  installOpencode(sys);
  writeFileSync(join(oc, "skills/starbridge/SKILL.md"), "---\nname: starbridge\n---\n");
  expect(opencodeState(sys)).toBe("foreign");
  rmSync(join(oc, "skills/starbridge/SKILL.md"));

  // An entry the owner took over (its marker gone) keeps its code at uninstall.
  rmSync(join(oc, "plugins/starbridge.ts"));
  installOpencode(sys);
  const entry = readFileSync(join(oc, "plugins/starbridge.ts"), "utf8");
  writeFileSync(join(oc, "plugins/starbridge.ts"), entry.split("\n").slice(1).join("\n"));
  removeOpencode(sys);
  expect(existsSync(join(oc, "starbridge/mod/opencode/starbridge.ts"))).toBe(true);
  expect(existsSync(join(oc, "skills/starbridge"))).toBe(false);
});

test("on Windows, setup registers a logon task that runs the agent headless, and uninstall removes it", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  const local = join(m.home, "AppData", "Local");
  Object.assign(m.ctx.env, {
    SystemRoot: join(import.meta.dir, "fixtures", "fake-windows"),
    LOCALAPPDATA: local,
    USERDOMAIN: "PC",
    USERNAME: "tom",
  });
  const sys: Sys = {
    ...m.sys,
    platform: "win32",
    self: ["C:\\Users\\tom\\.local\\bin\\starbridge.exe"],
  };
  expect(await setup(sys, { yes: true, readyTimeoutMs: 2_000 })).toBe(0);

  const path = join(local, "starbridge", "starbridge-agent.xml");
  const bytes = readFileSync(path);
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
  const task = bytes.toString("utf16le");
  expect(task).toContain(`<!-- Written by starbridge ${VERSION};`);
  expect(task).toContain("<UserId>PC\\tom</UserId>");
  expect(task).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  expect(task).toContain(
    `<Arguments>--headless C:\\Users\\tom\\.local\\bin\\starbridge.exe agent --log ${join(local, "starbridge", "agent.log")}</Arguments>`,
  );
  const ps = () => m.calls().filter((c) => c.startsWith("powershell"));
  expect(ps().some((c) => c.startsWith("powershell Register-ScheduledTask"))).toBe(true);
  expect(ps()).toContain("powershell Start-ScheduledTask -TaskName starbridge-agent");

  // A second setup finds the same task and leaves the running agent alone.
  const before = ps().length;
  await setup(sys, { yes: true, readyTimeoutMs: 2_000 });
  expect(
    ps()
      .slice(before)
      .some((c) => c.startsWith("powershell Start-")),
  ).toBe(false);

  m.ctx.lines.length = 0;
  expect(await uninstall(sys, { purge: true })).toBe(0);
  expect(m.ctx.lines).toContain("Stopped and removed the agent service.");
  expect(ps().some((c) => c.startsWith("powershell Unregister-ScheduledTask"))).toBe(true);
  expect(existsSync(path)).toBe(false);
});
