import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allowPiRules,
  dropUnsafePiRules,
  piAllow,
  piPermissionConfig,
  piRules,
  piSkillDir,
  removePiEntries,
} from "../src/pi";

/** A HOME with pi-permission-system `version` installed by Pi, and `config`. */
function home(config: unknown, version: string | null = "40.0.0") {
  const env = { HOME: mkdtempSync(join(tmpdir(), "starbridge-pi-")) };
  const file = piPermissionConfig(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
  if (version) {
    const pkg = join(env.HOME, ".pi/agent/npm/node_modules/@gotgenes/pi-permission-system");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version }));
  }
  return { env, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("the starbridge patterns go last, where an owner's later pattern cannot shadow them", () => {
  const h = home({ permission: { bash: { "*": "ask", "starbridge ask *": "allow" } } });
  const { bash } = piRules(h.env);
  expect(piAllow(h.env).state).toBe("missing");
  allowPiRules(h.env);
  expect(piAllow(h.env).state).toBe("allowed");

  // The owner adds a pattern after them that matches them: they are shadowed, so offered again.
  const permission = h.read().permission;
  permission.bash = { ...permission.bash, "starbridge *": "ask" };
  writeFileSync(h.file, JSON.stringify({ permission }));
  expect(piAllow(h.env).state).toBe("missing");
  allowPiRules(h.env);
  expect(Object.keys(h.read().permission.bash)).toEqual(["*", "starbridge *", ...(bash ?? [])]);
});

test("the skill is allowed by name and by its own folder only; a plain allow needs nothing", () => {
  const h = home({ permission: { "*": "ask", read: "allow" } });
  allowPiRules(h.env);
  expect(h.read().permission).toEqual({
    "*": "ask",
    read: "allow",
    bash: Object.fromEntries((piRules(h.env).bash ?? []).map((p) => [p, "allow"])),
    skill: { starbridge: "allow" },
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
  expect(piAllow(h.env)).toMatchObject({ state: "missing", plain: ["bash", "read"] });
  allowPiRules(h.env);
  expect(h.read().permission).toEqual({
    bash: "ask",
    read: "deny",
    skill: { starbridge: "allow" },
  });
  expect(piAllow(h.env)).toMatchObject({ state: "allowed", plain: ["bash", "read"] });
});

test("where pi-permission-system matches a whole chain, the bash patterns go (#488)", () => {
  const bash = Object.fromEntries(
    ["ask", "waiting", "working", "wait", "settle"].map((c) => [`starbridge ${c} *`, "allow"]),
  );
  const config = { permission: { bash: { "*": "ask", ...bash } } };
  for (const version of ["5.18.1", "9.0.0", null]) {
    const h = home(config, version);
    expect(piRules(h.env).bash).toBeUndefined();
    // Left there, they let `starbridge ask x; curl … | sh` run: so something is missing.
    expect(piAllow(h.env).state).toBe("missing");
    allowPiRules(h.env);
    expect(h.read().permission.bash).toEqual({ "*": "ask" });
    expect(piAllow(h.env).state).toBe("allowed");
    // The agent takes them out at start.
    const started = home(config, version);
    expect(dropUnsafePiRules(started.env)).toBe(true);
    expect(started.read().permission.bash).toEqual({ "*": "ask" });
  }
  // From 9.0.1 each command of a chain is gated on its own: they stay.
  for (const version of ["9.0.1", "9.1.0", "40.0.0"]) {
    const h = home(config, version);
    expect(dropUnsafePiRules(h.env)).toBe(false);
    allowPiRules(h.env);
    expect(h.read().permission.bash).toEqual(config.permission.bash);
  }
  // Uninstall takes them out whatever the version.
  const old = home({ permission: { bash } }, null);
  expect(removePiEntries(old.env)).toBe(true);
});
