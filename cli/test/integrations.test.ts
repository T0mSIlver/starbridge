/**
 * Setup writes nothing that uninstall and status do not know (docs/checks.md, "Uninstall missing
 * something setup did"): every file setup writes in HOME lies under the `paths` of an entry of
 * `INTEGRATIONS`, which status and uninstall read, and uninstall leaves none of them changed.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { makeAgent } from "../src/agent/main";
import { AGENT_IDS, AGENTS, HARNESSES } from "../src/setup/agents";
import { INTEGRATIONS, PATH_LINE, SERVICE } from "../src/setup/integrations";
import { setup } from "../src/setup/setup";
import { status } from "../src/setup/status";
import { defaults, type Sys } from "../src/setup/sys";
import { uninstall } from "../src/setup/uninstall";
import { FAKE_BIN, paired, SYSTEM_PATH } from "./helpers";

setDefaultTimeout(60_000);

/** Every path under `root`, with a file's text or "dir". */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) {
        out.set(path, "dir");
        walk(path);
      } else out.set(path, readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

const changed = (before: Map<string, string>, after: Map<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));

// The fake agents are shell scripts, which Windows does not start as the walk's do.
test.skipIf(process.platform === "win32")(
  "everything setup writes belongs to an integration that status and uninstall know",
  async () => {
    const server = await LiveServer.start();
    try {
      const ctx = await paired(server);
      const home = mkdtempSync(join(tmpdir(), "starbridge-integrations-"));
      // The fakes' own state stays out of HOME: it is not Starbridge's.
      const fakes = mkdtempSync(join(tmpdir(), "starbridge-fakes-"));
      Object.assign(ctx.env, {
        HOME: home,
        USER: "dev",
        PATH: [FAKE_BIN, dirname(process.execPath), SYSTEM_PATH].join(delimiter),
        FAKE_LOG: join(fakes, "log"),
        FAKE_STATE: fakes,
        // Setup's fetch of the Pi package fails at once, as offline: the fake Pi installs it.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.file:///nonexistent/.insteadOf",
        GIT_CONFIG_VALUE_0: "https://github.com/",
      });
      // Antigravity, found by its folder, and pi-permission-system, which setup adds rules to.
      mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
      const piConfig = join(home, ".pi/agent/extensions/pi-permission-system/config.json");
      mkdirSync(dirname(piConfig), { recursive: true });
      writeFileSync(piConfig, `${JSON.stringify({ permission: {} }, null, 2)}\n`);
      const sys: Sys = {
        ctx,
        home,
        platform: "linux",
        arch: "x64",
        uid: 1000,
        prompt: defaults,
        // Not on the PATH, so setup adds the PATH line.
        self: [join(home, ".local", "bin", "starbridge")],
      };
      const agent = makeAgent(ctx);
      await agent.start();
      try {
        const before = snapshot(home);
        expect(await setup(sys, { yes: true, noQuota: true, readyTimeoutMs: 2_000 })).toBe(0);
        for (const id of AGENT_IDS)
          expect(ctx.lines.some((l) => l.startsWith(`✓ ${AGENTS[id]} `))).toBe(true);

        const known = INTEGRATIONS.flatMap((i) => i.paths(sys));
        const under = (p: string) => known.some((k) => p === k || p.startsWith(`${k}${sep}`));
        // A folder setup made to hold a known path is known too.
        const holds = (p: string) => known.some((k) => k.startsWith(`${p}${sep}`));
        // The fake Codex keeps the marketplaces it was given in HOME, as the real one does in
        // its config.toml.
        const written = changed(before, snapshot(home)).filter(
          (p) => !p.endsWith(".fake-marketplace"),
        );
        expect(written.filter((p) => !under(p) && !holds(p)).map((p) => relative(home, p))).toEqual(
          [],
        );

        ctx.lines.length = 0;
        await status(sys);
        expect(ctx.lines.filter((l) => /not installed|not on the PATH/.test(l))).toEqual([]);

        ctx.lines.length = 0;
        await uninstall(sys, {
          purge: true,
          install: { kind: "binary", path: join(home, ".local", "bin", "starbridge") },
        });
        // Each is out again: the agents still here say Starbridge is not in them, and the
        // service's and the PATH line's files are as before. The walk (walk.test.ts) checks every
        // byte of HOME with fakes that leave what the real agents leave.
        for (const id of AGENT_IDS) expect(await HARNESSES[id].installed(sys)).toBe(false);
        const after = snapshot(home);
        for (const path of [...SERVICE.paths(sys), ...PATH_LINE.paths(sys)])
          expect(after.get(path)).toBe(before.get(path));
      } finally {
        await agent.stop();
      }
    } finally {
      server.stop();
    }
  },
);
