import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv } from "../src/config";
import { makeServer } from "../test-support/app";

/**
 * The environment deploy/host/server-env.sh gives the hosted server, from prod's settings and
 * every secret file holding "secret".
 */
const PROD = (() => {
  const dir = mkdtempSync(join(tmpdir(), "server-env-"));
  mkdirSync(join(dir, "secrets"));
  for (const f of [
    "github-oauth-client-secret",
    "vapid-public-key",
    "vapid-private-key",
    "apns-key-id",
    "apple-signin-key-id",
    "apns-key.p8",
    "apple-signin-key.p8",
  ])
    writeFileSync(join(dir, "secrets", f), "secret");
  writeFileSync(
    join(dir, "secrets/fcm-service-account.json"),
    JSON.stringify({ project_id: "secret", client_email: "secret", private_key: "secret" }),
  );
  const script = join(import.meta.dir, "../../deploy/host/server-env.sh");
  const r = spawnSync("sh", [script, dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`server-env.sh: ${r.stderr}`);
  return Object.fromEntries(
    [...readFileSync(join(dir, "server.env"), "utf8").matchAll(/^([A-Z_]+)='(.*)'$/gm)].map(
      ([, k, v]) => [k as string, v as string],
    ),
  );
})();
const DEMO = {
  PUBLIC_URL: "https://demo.starbridge.run",
  OWNER_TOKEN: "demo-owner-token-16",
  DEMO: "1",
};

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

test("a demo server keeps reviewers to its own machine", () => {
  const config = configFromEnv({ ...DEMO, MAX_MACHINES: "5" });
  expect(config.maxMachines).toBe(1);
});

test("a demo server keeps 200 testers' phones signed in, not 50", () => {
  expect(configFromEnv(DEMO).limits.sessions).toBe(200);
  expect(configFromEnv({ ...DEMO, DEMO: "" }).limits.sessions).toBe(50);
});
