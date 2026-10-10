import { beforeEach, expect, test } from "bun:test";
import {
  type Account,
  type Actor,
  makeServer,
  pair,
  revoke,
  type Server,
  setupAccount,
  signIn,
} from "../test-support/app";

let s: Server;
let acct: Account;
let browser: Actor;
let devbox: Actor;

beforeEach(async () => {
  s = await makeServer();
  acct = await setupAccount(s);
  browser = await pair(s, acct, "brave", "device", await signIn(s));
  devbox = await pair(s, acct, "devbox", "machine");
});

const put = (token: string, state: string) =>
  s.call("PUT", "/v1/notifications", { token, body: { state } });
const states = async (token = acct.device.token) =>
  (await s.call("GET", "/v1/notifications", { token })).json.devices;

test("each device says only its own notification state, and every device reads them all (#943)", async () => {
  expect(await states()).toEqual({});
  expect((await put(browser.token, "off")).status).toBe(204);
  expect((await put(acct.device.token, "blocked")).status).toBe(204);
  expect(await states(browser.token)).toEqual({ brave: "off", phone: "blocked" });
  expect((await put(browser.token, "on")).status).toBe(204);
  expect(await states()).toEqual({ brave: "on", phone: "blocked" });
  expect((await put(browser.token, "muted")).status).toBe(400);
  // A machine has no notifications to report or read.
  expect((await put(devbox.token, "on")).status).toBe(403);
  expect((await s.call("GET", "/v1/notifications", { token: devbox.token })).status).toBe(403);
});

test("a revoked device drops out of the list (#943)", async () => {
  await put(browser.token, "on");
  await revoke(s, acct, "brave");
  expect(await states()).toEqual({});
});

test("the list names the app each device said it from (#1019)", async () => {
  const desktop = await pair(s, acct, "app", "device", await signIn(s));
  await put(acct.device.token, "on");
  const cookie = (token: string, client: string) => ({
    cookie: `sb_session=${token}`,
    "starbridge-client": client,
  });
  const viaCookie = (token: string, client: string) =>
    s.call("PUT", "/v1/notifications", { headers: cookie(token, client), body: { state: "on" } });
  expect((await viaCookie(browser.token, "web/0.1.4")).status).toBe(204);
  expect((await viaCookie(desktop.token, "desktop/0.1.4")).status).toBe(204);
  const res = await s.call("GET", "/v1/notifications", { token: acct.device.token });
  expect(res.json.clients).toEqual({ phone: "android", brave: "web", app: "desktop" });
});
