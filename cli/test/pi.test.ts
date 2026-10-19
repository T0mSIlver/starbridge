import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allowPiRules,
  piAgentDir,
  piAllow,
  piBashDenies,
  piPermissionConfig,
  piRules,
  piSkillDir,
  removePiEntries,
} from "../src/pi";
import { configCommand } from "../src/settings";
import { defaults } from "../src/setup/sys";
import { testCtx } from "./helpers";

function home(config: unknown) {
  const env = { HOME: mkdtempSync(join(tmpdir(), "starbridge-pi-")) };
  const file = piPermissionConfig(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
  return { env, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("the starbridge patterns go last, where an owner's later pattern cannot shadow them", () => {
  const h = home({ permission: { skill: { "*": "ask", starbridge: "allow" } } });
  expect(piAllow(h.env).state).toBe("missing");
  allowPiRules(h.env);
  expect(piAllow(h.env).state).toBe("allowed");

  // The owner adds a pattern after them that matches them: they are shadowed, so offered again.
  const config = h.read();
  config.permission.skill = { ...config.permission.skill, "star*": "ask" };
  writeFileSync(h.file, JSON.stringify(config));
  expect(piAllow(h.env).state).toBe("missing");
  allowPiRules(h.env);
  expect(Object.keys(h.read().permission.skill)).toEqual(["*", "star*", "starbridge"]);
});

test("the skill is allowed by name and by its own folder only; a plain allow needs nothing", () => {
  const h = home({ permission: { "*": "ask", read: "allow" } });
  allowPiRules(h.env);
  expect(h.read()).toEqual({
    permission: { "*": "ask", read: "allow", skill: { starbridge: "allow" } },
    authorizerChain: ["starbridge"],
  });
  expect(piAllow(h.env).state).toBe("allowed");
  expect(piRules({ HOME: "/h" }).read).toEqual([
    `${join("/h", ".pi/agent/git/github.com/T0mSIlver/starbridge/plugin/skills/starbridge")}/*`,
  ]);
  expect(piSkillDir({ HOME: "/h", PI_CODING_AGENT_DIR: "/pi" })).toStartWith(join("/pi", "git"));
});

test("a plain ask or deny level is left to the owner, and the other surfaces still get theirs", () => {
  // As a map, a plain level would merge with a project's map instead of giving way to it.
  const h = home({ permission: { bash: "ask", read: "deny" } });
  expect(piAllow(h.env)).toMatchObject({ state: "missing", plain: ["read"] });
  allowPiRules(h.env);
  expect(h.read().permission).toEqual({
    bash: "ask",
    read: "deny",
    skill: { starbridge: "allow" },
  });
  expect(piAllow(h.env)).toMatchObject({ state: "allowed", plain: ["read"] });
});

test("a bash surface that denies stops the starbridge commands before the link hears them", () => {
  for (const permission of [{ bash: "deny" }, { bash: { "*": "deny" } }, { "*": "deny" }])
    expect(piBashDenies(home({ permission }).env)).toBe(true);
  for (const permission of [
    { bash: "ask" },
    { bash: { "*": "deny", "starbridge *": "ask" } },
    { "*": "deny", bash: { "*": "ask" } },
  ])
    expect(piBashDenies(home({ permission }).env)).toBe(false);
});

test("without HOME, Pi's folder is the OS's home folder's, not one relative to where setup runs (#1749)", () => {
  expect(piSkillDir({}).startsWith(join(homedir(), ".pi", "agent"))).toBe(true);
});

test("Pi's agent folder expands a leading ~ as Pi does, ~\\ on Windows too (#2039)", () => {
  const home = join(tmpdir(), "home");
  expect(piAgentDir({ HOME: home, PI_CODING_AGENT_DIR: "~" })).toBe(home);
  expect(piAgentDir({ HOME: home, PI_CODING_AGENT_DIR: "~/pi" })).toBe(join(home, "pi"));
  expect(piAgentDir({ HOME: home, PI_CODING_AGENT_DIR: join(home, "x") })).toBe(join(home, "x"));
  expect(piAgentDir({ HOME: home })).toBe(join(home, ".pi", "agent"));
  if (process.platform === "win32")
    expect(piAgentDir({ HOME: home, PI_CODING_AGENT_DIR: "~\\pi" })).toBe(join(home, "pi"));
});

test("uninstall takes out only the rules Starbridge added, and always its link (#2130)", () => {
  // The owner allowed the skill by name already; Starbridge adds its folder and the link.
  const h = home({ permission: { skill: { starbridge: "allow" } }, authorizerChain: ["judge"] });
  const { added, chained } = allowPiRules(h.env);
  expect(added).toEqual({ rules: { read: piRules(h.env).read as string[] } });
  expect(chained).toBe(false);
  expect(h.read().authorizerChain).toEqual(["judge", "starbridge"]);
  expect(removePiEntries(h.env, added)).toBe(true);
  expect(h.read()).toEqual({
    permission: { skill: { starbridge: "allow" } },
    authorizerChain: ["judge"],
  });
  // Without a record, from an earlier release: every entry of Starbridge's goes, as before.
  allowPiRules(h.env);
  removePiEntries(h.env);
  expect(h.read()).toEqual({ authorizerChain: ["judge"] });
});

test("permission prompts turned on cover Pi without a question of their own, and record what they add (#2130)", async () => {
  const h = home({ authorizerChain: ["judge"] });
  const ctx = testCtx(h.env);
  const asked: string[] = [];
  const prompt = { ...defaults, confirm: async (q: string) => !!asked.push(q) };
  expect(await configCommand(ctx, ["permissions", "on"], prompt)).toBe(0);
  expect(asked).toEqual([]);
  expect(h.read().authorizerChain).toEqual(["judge", "starbridge"]);
  expect(ctx.store.state().piAdded?.rules?.skill).toEqual(["starbridge"]);
  expect(ctx.lines.join("\n")).toContain("`starbridge uninstall` takes out what it added");
});

test("on a machine an earlier release set up, the first record takes Starbridge's rules as its own (#2130)", async () => {
  // An earlier release named the link and allowed the skill, and kept no record.
  const h = home({
    permission: { skill: { starbridge: "allow" } },
    authorizerChain: ["starbridge"],
  });
  const ctx = testCtx(h.env);
  expect(await configCommand(ctx, ["permissions", "on"], defaults)).toBe(0);
  removePiEntries(h.env, ctx.store.state().piAdded);
  expect(existsSync(h.file)).toBe(false);
});

test("a rule the owner had, with no link yet, stays theirs when prompts are turned on (#2130)", async () => {
  const h = home({ permission: { skill: { starbridge: "allow" } } });
  const ctx = testCtx(h.env);
  expect(await configCommand(ctx, ["permissions", "on"], defaults)).toBe(0);
  removePiEntries(h.env, ctx.store.state().piAdded);
  expect(h.read()).toEqual({ permission: { skill: { starbridge: "allow" } } });
});
