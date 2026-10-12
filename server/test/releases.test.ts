import { beforeEach, expect, test } from "bun:test";
import {
  type Account,
  type Actor,
  makeServer,
  pair,
  revoke,
  type Server,
  setupAccount,
} from "../test-support/app";

let s: Server;
let acct: Account;
let devbox: Actor;
let laptop: Actor;

beforeEach(async () => {
  s = await makeServer();
  acct = await setupAccount(s);
  devbox = await pair(s, acct, "devbox", "machine");
  laptop = await pair(s, acct, "laptop", "machine");
});

const put = (token: string, body: unknown) => s.call("PUT", "/v1/release", { token, body });
const releases = async () =>
  (await s.call("GET", "/v1/releases", { token: acct.device.token })).json.machines;

test("each machine says its release, and devices read which are behind (#1050)", async () => {
  expect(await releases()).toEqual({});
  expect((await put(devbox.token, { version: "0.1.2", latest: "0.2.0" })).status).toBe(204);
  expect((await put(laptop.token, { version: "0.2.0", latest: null })).status).toBe(204);
  expect(await releases()).toEqual({
    devbox: { version: "0.1.2", latest: "0.2.0", behind: true, updatedAt: null },
    laptop: { version: "0.2.0", latest: null, behind: false, updatedAt: null },
  });
  // A release candidate of the latest is behind it; a newer one is not.
  await put(devbox.token, { version: "0.2.0-rc.1", latest: "0.2.0" });
  await put(laptop.token, { version: "0.3.0-rc.1", latest: "0.2.0" });
  const m = await releases();
  expect([m.devbox.behind, m.laptop.behind]).toEqual([true, false]);
  expect((await put(devbox.token, { version: "0.2", latest: null })).status).toBe(400);
  // Devices have no release to report, and machines read no one's.
  expect((await put(acct.device.token, { version: "0.2.0", latest: null })).status).toBe(403);
  expect((await s.call("GET", "/v1/releases", { token: devbox.token })).status).toBe(403);
});

test("a revoked machine drops out of the list (#1050)", async () => {
  await put(devbox.token, { version: "0.1.2", latest: "0.2.0" });
  await revoke(s, acct, "devbox");
  expect(await releases()).toEqual({});
});

test("a machine that says another release stamps when it moved (#1266)", async () => {
  await put(devbox.token, { version: "0.1.2", latest: "0.2.0" });
  await put(devbox.token, { version: "0.1.2", latest: "0.2.0" });
  expect((await releases()).devbox.updatedAt).toBeNull();
  const before = new Date().toISOString();
  await put(devbox.token, { version: "0.2.0", latest: "0.2.0" });
  const at = (await releases()).devbox.updatedAt;
  expect(at >= before).toBe(true);
  // The same release again keeps the time.
  await put(devbox.token, { version: "0.2.0", latest: null });
  expect((await releases()).devbox.updatedAt).toBe(at);
});
