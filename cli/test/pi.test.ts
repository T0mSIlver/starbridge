import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { allowPiCommands, PI_ALLOW, piAllow, piPermissionConfig } from "../src/pi";

function home(config: unknown) {
  const env = { HOME: mkdtempSync(join(tmpdir(), "starbridge-pi-")) };
  const file = piPermissionConfig(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
  return { env, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("the starbridge patterns go last, where an owner's later pattern cannot shadow them", () => {
  const h = home({ permission: { bash: { "*": "ask", "starbridge ask *": "allow" } } });
  expect(piAllow(h.env).state).toBe("missing");
  allowPiCommands(h.file);
  expect(piAllow(h.env).state).toBe("allowed");

  // The owner adds a pattern after them that matches them: they are shadowed, so offered again.
  const bash = { ...h.read().permission.bash, "starbridge *": "ask" };
  writeFileSync(h.file, JSON.stringify({ permission: { bash } }));
  expect(piAllow(h.env).state).toBe("missing");
  allowPiCommands(h.file);
  expect(Object.keys(h.read().permission.bash)).toEqual(["*", "starbridge *", ...PI_ALLOW]);
});

test("a plain bash level is left to the owner: as a map it would merge with a project's", () => {
  const h = home({ permission: { bash: "allow" } });
  expect(piAllow(h.env).state).toBe("unreadable");
});
