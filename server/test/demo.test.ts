import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configFromEnv } from "../src/config";
import { makeServer } from "../test-support/app";

/**
 * The environment deploy/host/server-env.sh gives the hosted server, each secret read from a file
 * replaced by "secret".
 */
const PROD = Object.fromEntries(
  [
    ...readFileSync(join(import.meta.dir, "../../deploy/host/server-env.sh"), "utf8").matchAll(
      /"([A-Z_]+)='([^'$]*)/g,
    ),
  ].map(([, k, v]) => [k as string, v || "secret"]),
);
const DEMO = { PUBLIC_URL: "https://demo.starbridge.run", OWNER_TOKEN: "t", DEMO: "1" };

test("DEMO=1 is refused with anything the hosted server sets", () => {
  expect(() => configFromEnv({ ...PROD, DEMO: "1" })).toThrow("DEMO=1 is refused");
  expect(PROD.PUBLIC_URL).toBe("https://starbridge.run");
  for (const k of ["PUBLIC_URL", "RELAY_MODE", "GITHUB_CLIENT_ID"])
    expect(() => configFromEnv({ ...DEMO, GITHUB_CLIENT_SECRET: "s", [k]: PROD[k] })).toThrow(
      "DEMO=1 is refused",
    );
  expect(() => configFromEnv({ ...DEMO, OWNER_TOKEN: "" })).toThrow("no OWNER_TOKEN");
  expect(configFromEnv(DEMO).demo).toBe(true);
  expect(configFromEnv(PROD).demo).toBe(false);
});

test("/v1/demo exists only on a demo server", async () => {
  expect((await (await makeServer()).app.request("/v1/demo")).status).toBe(404);
  expect((await (await makeServer({ demo: true })).app.request("/v1/demo")).status).toBe(200);
});
