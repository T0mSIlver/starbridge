import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { LiveServer } from "@starbridge/server/test-support";
import { type Status, socketPath } from "../src/agent/api";
import { AgentClient } from "../src/agent/client";
import { makeAgent } from "../src/agent/main";
import type { Agent } from "../src/agent/server";
import { REMOVED } from "../src/api";
import { run } from "../src/cli";
import { session } from "../src/context";
import { poll } from "../src/decisions";
import { pushOnce } from "../src/quota";
import { installTarball, tarballKey, updateCodexbar } from "../src/setup/codexbar";
import {
  CODEX_RULE,
  installOpencode,
  opencodeState,
  PI_PACKAGE,
  piPackage,
  removeOpencode,
} from "../src/setup/harnesses";
import { markedSkill } from "../src/setup/marker";
import opencodeFiles from "../src/setup/opencode-files.js";
import {
  installService,
  removeService,
  serviceState,
  withInstalledPlaces,
} from "../src/setup/service";
import { probeLines, refresh, setup } from "../src/setup/setup";
import { status } from "../src/setup/status";
import { defaults, failure, type Sys } from "../src/setup/sys";
import { uninstall } from "../src/setup/uninstall";
import { VERSION } from "../src/version";
import { approveAndConfirm, paired, type TestCtx, testCtx, until } from "./helpers";

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
async function machine(name?: string) {
  const ctx = await paired(server, name);
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

  // A slow agent says it is installing first; what is left to do comes only at the end (#773).
  expect(out).toContain("  Claude Code  installing…\n✓ Claude Code  plugins installed");
  const end = out.slice(out.indexOf("Starbridge is set up."));
  expect(end).toContain("  Paste these rules into Codex's instructions:\n");
  expect(out.indexOf("Paste these rules")).toBe(out.lastIndexOf("Paste these rules"));

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
  expect(out).toContain("✓ Sent a first quota snapshot: 2 providers");
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
  expect(m.ctx.lines).toContain("✓ Claude Code  plugins installed, 5 starbridge commands allowed");

  // A Codex skill from an older CLI is updated without a question, whatever the answers (#750).
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
  expect(asked.filter((q) => /Starbridge|skill|plugin/.test(q))).toEqual([]);
  expect(readFileSync(join(m.home, ".codex/skills/starbridge/SKILL.md"), "utf8")).not.toContain(
    "\nold\n",
  );

  // A Pi package at another release moves to this CLI's tag.
  const pi = join(m.home, ".pi/agent/settings.json");
  writeFileSync(pi, JSON.stringify({ packages: ["git:github.com/T0mSIlver/starbridge@v0.9.0"] }));
  await setup(m.sys, { yes: true, readyTimeoutMs: 2_000 });
  expect(JSON.parse(readFileSync(pi, "utf8")).packages).toEqual([PI_PACKAGE]);

  // A fork is the owner's own package: not Starbridge's (#763).
  for (const source of [
    "git:github.com/T0mSIlver/starbridge-fork@main",
    "https://github.com/T0mSIlver/starbridge.fork",
    "git:github.com/T0mSIlver/starbridge/extra",
  ]) {
    writeFileSync(pi, JSON.stringify({ packages: [source] }));
    expect(piPackage(m.sys)).toBeUndefined();
  }
  for (const source of [
    "git:github.com/T0mSIlver/starbridge",
    "https://github.com/T0mSIlver/starbridge.git@v0.9.0",
    "git:git@github.com:t0msilver/starbridge@main",
  ]) {
    writeFileSync(pi, JSON.stringify({ packages: [source] }));
    expect(piPackage(m.sys)).toBe(source);
  }
});

test("setup asks for no server: it pairs with the one named, and asks only to switch (#749)", async () => {
  const m = await machine();
  const asked: string[] = [];
  m.sys.prompt = { ...defaults, confirm: async (q, def) => (asked.push(q), def) };
  m.ctx.env.STARBRIDGE_SERVER = "https://other.example";
  const first = await setup(m.sys, { yes: true, noService: true, noQuota: true, noAgents: true });
  expect(first).toBe(0);
  const host = server.url.replace(/^https:\/\//, "");
  expect(asked[0]).toBe(`This machine is paired with ${host}. Pair it with other.example instead?`);
  // Enter keeps the pairing.
  expect(m.ctx.store.machine()?.server).toBe(server.url);

  // The same server, with a trailing slash: no question.
  asked.length = 0;
  m.ctx.env.STARBRIDGE_SERVER = `${server.url}/`;
  await setup(m.sys, { yes: true, noService: true, noQuota: true, noAgents: true });
  expect(asked.filter((q) => q.startsWith("This machine is paired"))).toEqual([]);

  // A new machine pairs with the server named, saying so first.
  const ctx = testCtx({ HOME: m.home, PATH: m.ctx.env.PATH as string });
  const fresh: Sys = { ...m.sys, ctx, prompt: { ...defaults, text: () => Promise.reject() } };
  const done = setup(fresh, {
    yes: true,
    server: server.url,
    noService: true,
    noQuota: true,
    noAgents: true,
  });
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  expect(ctx.lines).toContain(`Pairing with ${host}`);
  await approveAndConfirm(server, ctx);
  expect(await done).toBe(0);
  expect(ctx.store.machine()?.server).toBe(server.url);
});

test("a machine the server no longer lists: setup offers to pair again, else stops first (#774)", async () => {
  for (const yes of [false, true]) {
    const m = await machine();
    const before = m.ctx.store.machine()?.id as string;
    await server.revoke(before);
    m.sys.prompt = {
      ...defaults,
      confirm: async (q) => (q.includes("Pair this machine again") ? yes : false),
    };
    // Another server named, and the switch to it declined: pairing again stays on this one.
    const done = setup(m.sys, { noQuota: true, noService: true, server: "http://127.0.0.1:9" });
    if (yes) {
      await until(() => m.ctx.lines.some((l) => l.startsWith("Pairing code: ")));
      await approveAndConfirm(server, m.ctx);
    }
    expect(await done).toBe(yes ? 0 : 1);
    const out = m.ctx.lines.join("\n");
    expect(out).toContain(`✗ ${server.url} no longer lists`);
    if (yes) expect(m.ctx.store.machine()?.id).not.toBe(before);
    else {
      expect(out).toEndWith("  To pair it again later:\n    starbridge setup");
      expect(out).not.toContain("Agents");
    }
  }
});

test("a server setup cannot reach: setup stops before the other steps (#774)", async () => {
  const m = await machine();
  const paired = m.ctx.store.machine();
  if (paired) m.ctx.store.saveMachine({ ...paired, server: "http://127.0.0.1:9" });
  expect(await setup(m.sys, { noQuota: true, noService: true })).toBe(1);
  const out = m.ctx.lines.join("\n");
  expect(out).toContain("✗ Cannot reach http://127.0.0.1:9 (ConnectionRefused)\n");
  expect(out).toEndWith("  Retry with:\n    starbridge setup");
  expect(out).not.toContain("Agents");
});

test("setup asks before sending quotas that another machine already sends, and Enter skips (#748)", async () => {
  const devbox = await machine();
  await pushOnce(devbox.ctx, { providers: ["codex"], codexbar: join(FAKE_BIN, "codexbar") });
  const mac = await machine("mac");
  const asked: string[] = [];
  mac.sys.prompt = {
    ...defaults,
    confirm: async (q, def) => (asked.push(q), def),
  };
  expect(await setup(mac.sys, { yes: true, noService: true, readyTimeoutMs: 1 })).toBe(0);
  expect(asked[0]).toBe("  devbox already sends quotas. Send from this machine too?");
  expect(mac.ctx.lines).toContain("– Not sent from this machine");
  expect(mac.ctx.store.agentConfig().quota?.providers).toEqual([]);
  expect(mac.calls().some((c) => c.startsWith("codexbar"))).toBe(false);

  // devbox itself already sends them: no question.
  devbox.ctx.store.saveAgentConfig({ quota: { providers: ["codex"], interval: "5m" } });
  devbox.sys.prompt = { ...defaults, confirm: async (q, def) => (asked.push(q), def) };
  await setup(devbox.sys, { yes: true, noService: true, readyTimeoutMs: 1 });
  expect(asked.filter((q) => q.includes("already sends quotas"))).toHaveLength(1);
});

test("uninstall --agent leaves that agent out of setup, refresh and status until setup --agent (#750)", async () => {
  const m = await machine();
  const opts = { yes: true, noQuota: true, noService: true } as const;
  await setup(m.sys, opts);
  const skill = join(m.home, ".codex/skills/starbridge/SKILL.md");
  expect(existsSync(skill)).toBe(true);

  expect(await run(["uninstall", "--agent", "constructor", "--yes"], m.ctx)).not.toBe(0);
  m.ctx.lines.length = 0;
  expect(await run(["uninstall", "--agent", "codex", "--yes"], m.ctx)).toBe(0);
  expect(existsSync(skill)).toBe(false);
  expect(m.ctx.lines).toContain("  starbridge setup --agent codex");

  m.ctx.lines.length = 0;
  await setup(m.sys, opts);
  await refresh(m.sys);
  expect(existsSync(skill)).toBe(false);
  expect(m.ctx.lines).toContain("– Codex        left out, as `uninstall --agent` asked");
  m.ctx.lines.length = 0;
  await status(m.sys);
  expect(m.ctx.lines).toContain(
    "Codex: left out (`starbridge setup --agent codex` brings it back)",
  );

  expect(await setup(m.sys, { agent: "codex" })).toBe(0);
  expect(existsSync(skill)).toBe(true);
  expect(m.ctx.store.agentConfig().removedAgents).toBeUndefined();
});

test("an agent installed after setup: status says so, and refresh installs it (#750)", async () => {
  const m = await machine();
  rmSync(join(m.home, ".codex"), { recursive: true, force: true });
  await status(m.sys);
  expect(m.ctx.lines).toContain(
    "Codex found, Starbridge not installed: run `starbridge setup --refresh`",
  );
  const done = await refresh(m.sys);
  expect(done).toContain("✓ Codex        skill and sandbox rule installed");
  expect(existsSync(join(m.home, ".codex/skills/starbridge/SKILL.md"))).toBe(true);
});

test("a failed agent install says why and how to retry, and setup goes on (#750)", async () => {
  const m = await machine();
  m.ctx.env.PATH = `${join(m.home, "bin")}:${m.ctx.env.PATH}`;
  mkdirSync(join(m.home, "bin"));
  writeFileSync(
    join(m.home, "bin/pi"),
    "#!/bin/sh\necho 'fatal: could not read from github.com' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  expect(await setup(m.sys, { yes: true, noQuota: true, noService: true })).toBe(0);
  const out = m.ctx.lines.join("\n");
  expect(out).toContain(
    "✗ Pi           pi install " +
      PI_PACKAGE +
      ": fatal: could not read from github.com\n               Retry with:\n                 starbridge setup --agent pi",
  );
  expect(out).toContain("✓ opencode     skill and plugin installed");
  // The end says what failed and how to retry, not that all is set up (#770).
  expect(out).not.toContain("Starbridge is set up.");
  expect(out).toContain("Setup is done, but one step failed.");
  expect(out).toContain(
    `  ✗ Pi           pi install ${PI_PACKAGE}: fatal: could not read from github.com\n  Retry once fixed:\n    starbridge setup`,
  );
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
  const earlier = "Written by starbridge 0.0.1; `starbridge uninstall` removes it.";
  writeFileSync(rule, `# ${earlier}\nold\n`);
  writeFileSync(entry, `// ${earlier}\nold\n`);
  writeFileSync(unit, `# ${earlier}\nold\n`);
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

test("status names the Claude Code session it runs in when that session's mod never called (#863)", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  Object.assign(m.ctx.env, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s-1" });
  await status(m.sys);
  expect(m.ctx.lines.join("\n")).toContain("Not this session (s-1): no Starbridge mod runs in it");

  // A `claude -p` run has no mod by design.
  m.ctx.lines.length = 0;
  m.ctx.env.CLAUDE_CODE_SESSION_ATTENDED = "0";
  await status(m.sys);
  expect(m.ctx.lines.join("\n")).not.toContain("Not this session");
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
  // pi-permission-system with the owner's own policy and the link `config permissions on` adds.
  const pps = join(m.home, ".pi/agent/extensions/pi-permission-system/config.json");
  mkdirSync(dirname(pps), { recursive: true });
  const bash = { "*": "ask" };
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
  expect(await setup(m.sys, { yes: true, noAgents: true, readyTimeoutMs: 500 })).toBe(0);
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
  expect(await setup(m.sys, { yes: true, noAgents: true, readyTimeoutMs: 500 })).toBe(0);
  const out = m.ctx.lines.join("\n");
  expect(out).toContain(
    "✗ Could not start the service: systemctl --user enable starbridge-agent.service: Access denied\n  Retry with:\n    starbridge setup\n  Or keep one running yourself:\n    starbridge agent",
  );
});

test("an old Claude Code: setup says what failed and to update it (#620)", async () => {
  const m = await machine();
  Object.assign(m.ctx.env, { FAKE_CLAUDE_VERSION: "2.1.200", FAKE_NO_JSON: "1" });
  expect(await setup(m.sys, { yes: true, noQuota: true, noService: true })).toBe(0);
  expect(m.ctx.lines.join("\n")).toContain(
    "✗ Claude Code  `claude plugin marketplace list --json` failed (error: unknown option '--json'). Claude Code 2.1.200 is older than 2.1.287, the oldest Starbridge works with: `claude update` updates it\n               Retry with:\n                 starbridge setup --agent claude",
  );
});

for (const [how, shows] of [
  ["answered", "✓ You answered Yes"],
  ["snoozed", "Snoozed until"],
] as const)
  test(`the test decision, ${how}, prints what the owner did, not its id`, async () => {
    const m = await machine();
    const sys: Sys = {
      ...m.sys,
      prompt: {
        ...m.sys.prompt,
        confirm: async (q) => q.trim().startsWith("Send a test decision"),
      },
    };
    const done = setup(sys, { noQuota: true, noAgents: true, noService: true });
    await until(async () => (await server.opened("decision")).length === 1);
    const id = (await server.opened("decision"))[0]?.id as string;
    if (how === "answered") await server.answer(id, { choice: "Yes" });
    else await server.snooze(id, new Date(Date.now() + 3_600_000));
    expect(await done).toBe(0);
    const out = m.ctx.lines.join("\n");
    expect(out).toContain(shows);
    expect(out).not.toContain(id);
  });

test("Ctrl-C at the test decision withdraws it from the devices (#613)", async () => {
  const m = await machine();
  const stop = new AbortController();
  m.ctx.signal = stop.signal;
  const sys: Sys = {
    ...m.sys,
    prompt: { ...m.sys.prompt, confirm: async (q) => q.trim().startsWith("Send a test decision") },
  };
  const done = setup(sys, { noQuota: true, noAgents: true, noService: true });
  await until(async () => (await server.opened("decision")).length === 1);
  stop.abort();
  expect(await done).toBe(0);
  expect(m.ctx.lines).toContain("– Skipped");
  const [decision] = await server.opened("decision");
  const [settled] = await server.opened("settled");
  expect(settled?.itemId).toBe(decision?.id);
  expect(settled?.outcome).toBe("withdrawn");
});

/** A ustar archive of `entries`: "0" a file, "2" a symlink, "5" a folder; mtime 0, owner 0. */
function tar(
  entries: { name: string; type?: "0" | "2" | "5"; mode: number; data?: string; link?: string }[],
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const data = new TextEncoder().encode(e.data ?? "");
    const h = new Uint8Array(512);
    const put = (at: number, text: string) => h.set(new TextEncoder().encode(text), at);
    const octal = (at: number, len: number, n: number) =>
      put(at, `${n.toString(8).padStart(len - 1, "0")}\0`);
    put(0, e.name);
    octal(100, 8, e.mode);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, data.length);
    octal(136, 12, 0);
    put(148, " ".repeat(8));
    put(156, e.type ?? "0");
    put(157, e.link ?? "");
    put(257, "ustar\x0000");
    octal(
      148,
      7,
      h.reduce((a, b) => a + b, 0),
    );
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return Buffer.concat(blocks);
}

/**
 * CodexBar's releases as GitHub serves them: the API's latest tag, and each version's tarball
 * with a `.sha256` beside it, which `sums` replaces or, when null, leaves out. `latest` may
 * be changed while it serves.
 */
function fakeCodexbarReleases(latest: string, sums: (v: string, sha: string) => string | null) {
  const state = { latest };
  // Built once per version, in-process: a system tar adds mtimes, and on macOS extended
  // attributes, so its size and checksum would vary by host and by second (#756).
  const built = new Map<string, Uint8Array<ArrayBuffer>>();
  const tarball = (v: string) => {
    let bytes = built.get(v);
    if (!bytes) {
      bytes = new Uint8Array(
        gzipSync(
          tar([
            { name: "./", type: "5", mode: 0o755 },
            { name: "./CodexBarCLI", mode: 0o755, data: "#!/bin/sh\n" },
            { name: "./VERSION", mode: 0o644, data: `${v}\n` },
            { name: "./codexbar", type: "2", mode: 0o777, link: "CodexBarCLI" },
          ]),
        ),
      );
      built.set(v, bytes);
    }
    return bytes;
  };
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (path === "/rel/latest")
        return Response.redirect(`${server.url.href}rel/tag/v${state.latest}`, 302);
      const m = /^\/rel\/download\/v([^/]+)\/CodexBarCLI-v[^/]+-[^/]+\.tar\.gz(\.sha256)?$/.exec(
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

test("a CodexBar the system cannot start says what it needs, not to sign in (#771)", () => {
  const detail =
    "/home/u/.local/bin/codexbar: error while loading shared libraries: libsqlite3.so.0: cannot open shared object file: No such file or directory";
  const probes = ["claude", "codex"].map((provider) => ({
    provider,
    displayName: provider,
    works: false,
    detail,
  }));
  expect(probeLines({ platform: "linux" } as Sys, probes)).toEqual([
    "✗ CodexBar cannot start: it needs libsqlite3.so.0",
    "  On Debian or Ubuntu: sudo apt install libsqlite3-0",
    "  Then run again:",
    "    starbridge setup",
  ]);
});

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
    // linux-musl-x86_64 where the host has no glibc libcurl, such as a Mac.
    const key = tarballKey(sys) as string;
    const path = await installTarball(sys, key, "9.9.8");
    expect(path).toBe(join(home, ".local/opt/codexbar/codexbar"));
    ctx.lines.length = 0;
    const codes = [
      await updateCodexbar(sys, undefined),
      await updateCodexbar(sys, undefined),
      await updateCodexbar(sys, undefined, "v9.9.7"),
    ];
    expect(ctx.lines).toEqual([
      `Downloading CodexBar 9.9.9 (${key}), 1 kB`,
      `Installed CodexBar 9.9.9 to ${join(home, ".local/opt/codexbar")}, linked as ${join(home, ".local/bin/codexbar")}.`,
      "CodexBar 9.9.9 is up to date.",
      `Downloading CodexBar 9.9.7 (${key}), 1 kB`,
      `Installed CodexBar 9.9.7 to ${join(home, ".local/opt/codexbar")}, linked as ${join(home, ".local/bin/codexbar")}.`,
    ]);
    expect(codes).toEqual([0, 0, 0]);
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

test("on macOS, setup loads a launchd agent that runs the agent, and uninstall unloads it", async () => {
  const m = await machine();
  await startAgent(m.ctx);
  const sys: Sys = { ...m.sys, platform: "darwin", arch: "arm64", uid: 501 };
  expect(await setup(sys, { yes: true, readyTimeoutMs: 2_000 })).toBe(0);

  const path = join(m.home, "Library/LaunchAgents/run.starbridge.agent.plist");
  const plist = readFileSync(path, "utf8");
  expect(plist).toContain(`<!-- Written by starbridge ${VERSION};`);
  expect(plist).toContain(`<string>${SELF}</string>\n    <string>agent</string>`);
  expect(plist).toContain(
    `<key>StandardOutPath</key>\n  <string>${join(m.home, "Library/Logs/starbridge-agent.log")}</string>`,
  );
  const lc = () => m.calls().filter((c) => c.startsWith("launchctl"));
  expect(lc()).toContain(`launchctl bootstrap gui/501 ${path}`);

  // A second setup finds the same plist and leaves the running agent alone.
  const before = lc().length;
  await setup(sys, { yes: true, readyTimeoutMs: 2_000 });
  expect(
    lc()
      .slice(before)
      .some((c) => c.startsWith("launchctl bootstrap")),
  ).toBe(false);

  m.ctx.lines.length = 0;
  expect(await uninstall(sys, { purge: true })).toBe(0);
  expect(m.ctx.lines).toContain("Stopped and removed the agent service.");
  expect(lc()).toContain("launchctl bootout gui/501/run.starbridge.agent");
  expect(existsSync(path)).toBe(false);
});

// The real launchd, on GitHub's macOS runners only: its label is the one an installed agent uses.
test.if(process.platform === "darwin" && process.env.RUNNER_ENVIRONMENT === "github-hosted")(
  "on a Mac, launchd starts the agent from the plist setup writes, and stops it",
  async () => {
    const ctx = await paired(server);
    const home = mkdtempSync(join(tmpdir(), "starbridge-home-"));
    Object.assign(ctx.env, {
      HOME: home,
      PATH: "/usr/bin:/bin",
      STARBRIDGE_CONFIG_DIR: ctx.store.dir,
    });
    const sys: Sys = {
      ctx,
      home,
      platform: "darwin",
      arch: process.arch,
      uid: process.getuid?.() ?? 0,
      prompt: defaults,
      self: [process.execPath, join(import.meta.dir, "../src/main.ts")],
    };
    const { path } = await installService(sys, false);
    try {
      expect(spawnSync("plutil", ["-lint", path]).status).toBe(0);
      const client = new AgentClient(socketPath(ctx.env, ctx.store.dir));
      let pid: number | undefined;
      await until(async () => {
        pid = await client
          .call<Status>("GET", "/v1/status", undefined, 1_000)
          .then((s) => s.pid)
          .catch(() => undefined);
        return pid !== undefined;
      }, 20_000);
      expect(pid).not.toBe(process.pid);
      expect((await serviceState(sys)).state).toBe("running");
    } finally {
      expect(await removeService(sys)).toBe(true);
    }
    expect((await serviceState(sys)).state).toBe("not loaded");
    expect(existsSync(path)).toBe(false);
  },
);
