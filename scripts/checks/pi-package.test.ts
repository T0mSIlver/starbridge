// Pi installs Starbridge by running `npm install --omit=dev` in this repository's root (spec/machines.md),
// so npm must find nothing to install there. A root `workspaces` list made npm install every package of
// the monorepo, whose pnpm `workspace:*` dependencies it refuses, and broke every Pi install (#2371).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"));

test("the root package.json gives npm nothing to install for Pi (#2371)", () => {
  expect(pkg.workspaces).toBeUndefined();
  expect(pkg.dependencies).toBeUndefined();
  expect(pkg.optionalDependencies).toBeUndefined();
  expect(pkg.peerDependencies).toBeUndefined();
});
