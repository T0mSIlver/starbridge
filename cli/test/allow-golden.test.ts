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
