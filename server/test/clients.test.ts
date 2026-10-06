import { expect, test } from "bun:test";
import { aggregate, dayOf } from "../src/usage";
import { makeServer, setupAccount } from "../test-support/app";

test("a release below its client's minimum gets 426; others, and requests without one, pass", async () => {
  const s = await makeServer({ minimumReleases: { cli: "1.2.0" } });
  const acct = await setupAccount(s);
  const me = (client?: string) =>
    s.call("GET", "/v1/me", {
      token: acct.device.token,
      headers: client ? { "starbridge-client": client } : {},
    });

  const old = await me("cli/1.1.9");
  expect(old.status).toBe(426);
  expect(old.json).toMatchObject({ error: "client-too-old", client: "cli", minimum: "1.2.0" });
  expect((await me("cli/1.2.0-rc.1")).status).toBe(200);
  expect((await me("android/0.1.0")).status).toBe(200);
  expect((await me("cli/garbage")).status).toBe(200);
  expect((await me()).status).toBe(200);
});

test("the day counts each member's first release once", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  for (const client of ["android/1.0.3", "android/1.0.4", "android/9.9.9"])
    await s.call("GET", "/v1/me", {
      token: acct.device.token,
      headers: { "starbridge-client": client },
    });
  const day = aggregate(s.deps.db, dayOf(Date.now()));
  expect(day["active.clients.android.1.0"]).toBe(1);
  expect(day["active.clients.android.9.9"]).toBeUndefined();
});
