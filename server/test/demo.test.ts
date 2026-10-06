import { expect, test } from "bun:test";
import { configFromEnv } from "../src/config";
import { makeServer } from "../test-support/app";

/** What deploy/host/server-env.sh gives the hosted server, secrets aside. */
const PROD = {
  PUBLIC_URL: "https://starbridge.run",
  RELAY_MODE: "1",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
};
const DEMO = { PUBLIC_URL: "https://demo.starbridge.run", OWNER_TOKEN: "t", DEMO: "1" };

test("DEMO=1 is refused with anything the hosted server sets", () => {
  expect(() => configFromEnv({ ...PROD, DEMO: "1" })).toThrow("DEMO=1 is refused");
  for (const [k, v] of Object.entries(PROD))
    if (k !== "GITHUB_CLIENT_SECRET")
      expect(() => configFromEnv({ ...DEMO, GITHUB_CLIENT_SECRET: "s", [k]: v })).toThrow(
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
