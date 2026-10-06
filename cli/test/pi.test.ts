import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allowPiRules,
  dropOldPiRules,
  oldPiRulesStuck,
  piAllow,
  piBashDenies,
  piPermissionConfig,
  piRules,
  piSkillDir,
  removePiEntries,
} from "../src/pi";

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
    "/h/.pi/agent/git/github.com/T0mSIlver/starbridge/plugin/skills/starbridge/*",
  ]);
  expect(piSkillDir({ HOME: "/h", PI_CODING_AGENT_DIR: "/pi" })).toStartWith("/pi/git/");
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

test("the bash patterns setup added before #488 are taken out, and offered no more", () => {
  const old = Object.fromEntries(
    ["ask", "waiting", "working", "wait", "settle"].map((c) => [`starbridge ${c} *`, "allow"]),
  );
  const config = { permission: { bash: { "*": "ask", ...old } }, authorizerChain: ["starbridge"] };
  const h = home(config);
  // Left behind, they keep the hole open, so piAllow says something is missing.
  expect(piAllow(h.env).state).toBe("missing");
  allowPiRules(h.env);
  expect(h.read().permission.bash).toEqual({ "*": "ask" });
  expect(piAllow(h.env).state).toBe("allowed");

  // The agent takes them out at start; alone in the bash map, the map goes.
  const started = home(config);
  expect(dropOldPiRules(started.env)).toBe(true);
  expect(dropOldPiRules(started.env)).toBe(false);
  expect(started.read().permission.bash).toEqual({ "*": "ask" });
  const only = home({ permission: { bash: old } });
  expect(dropOldPiRules(only.env)).toBe(true);
  expect(only.read()).toEqual({ permission: {} });
  // Uninstall does too; a level of the owner's own on the same pattern stays.
  const left = home({ permission: { bash: { ...old, "starbridge settle *": "deny" } } });
  expect(removePiEntries(left.env)).toBe(true);
  expect(left.read().permission.bash).toEqual({ "starbridge settle *": "deny" });
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

test("old bash patterns in a config with comments are reported, not left silently", () => {
  const h = home({});
  writeFileSync(
    h.file,
    '{\n  // mine\n  "permission": {"bash": {"starbridge ask *": "allow"}}\n}\n',
  );
  expect(oldPiRulesStuck(h.env)).toBe(true);
  expect(() => dropOldPiRules(h.env)).toThrow("by hand");
  writeFileSync(h.file, "{\n  // mine\n}\n");
  expect(oldPiRulesStuck(h.env)).toBe(false);
  expect(dropOldPiRules(h.env)).toBe(false);
});
