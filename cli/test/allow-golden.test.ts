// Each harness's settings file as setup writes it, before and after adding, checking and removing
// its allow entries (#1903). fixtures/allow-golden.json holds what the code wrote before the
// entries moved into one table, so a change to what lands in a user's file shows up there.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALLOW, type AllowList, addAllow, missingAllow, removeAllow } from "../src/setup/allow";
import golden from "./fixtures/allow-golden.json";

type Case = { before: string | null; missing: string[] } & Record<string, unknown>;

const OPS: Record<string, (list: AllowList, sys: Parameters<typeof addAllow>[1]) => unknown> = {
  missing: missingAllow,
  add: addAllow,
  removeStale: (list, sys) => removeAllow(list, sys, true),
  remove: (list, sys) => removeAllow(list, sys),
};

for (const [harness, cases] of Object.entries(golden as Record<string, Record<string, Case>>)) {
  const list = ALLOW[harness as keyof typeof ALLOW];
  for (const [name, c] of Object.entries(cases))
    test(`${harness}, ${name}`, () => {
      for (const [op, run] of Object.entries(OPS)) {
        if (!(op in c)) continue;
        const home = mkdtempSync(join(tmpdir(), "allow-golden-"));
        try {
          const sys = { home, ctx: { env: {} } } as Parameters<typeof addAllow>[1];
          const path = list.path(sys);
          if (c.before !== null) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, c.before);
          }
          const result = run(list, sys);
          const after = existsSync(path) ? readFileSync(path, "utf8") : null;
          expect(op === "missing" ? result : { result, after }, op).toEqual(c[op]);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    });
}

// A file that exists but cannot be read, which the fixture cannot hold: as before #1903, Claude
// Code's and Antigravity's add refuses it, and Cursor's counts it as empty, then fails to replace it.
test.skipIf(process.getuid?.() === 0)("an unreadable file is left alone", () => {
  for (const [harness, list] of Object.entries(ALLOW)) {
    const home = mkdtempSync(join(tmpdir(), "allow-golden-"));
    try {
      const sys = { home, ctx: { env: {} } } as Parameters<typeof addAllow>[1];
      const path = list.path(sys);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"permissions":{"allow":["Other(ls)"]}}', { mode: 0o000 });
      expect(missingAllow(list, sys), harness).toEqual([...list.rules]);
      if (harness === "cursor") expect(() => addAllow(list, sys), harness).toThrow("EACCES");
      else expect(addAllow(list, sys), harness).toBe(false);
      expect(removeAllow(list, sys), harness).toBe(false);
      expect(() => readFileSync(path, "utf8"), harness).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
