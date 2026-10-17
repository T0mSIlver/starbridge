import { expect, test } from "bun:test";
import { APP_SIGN_IN_MS, AppSignIns } from "../src/appSignIns";
import { makeServer, setupAccount } from "../test-support/app";

const T0 = 1_000_000;
/** Sign-ins kept at once (appSignIns.ts). */
const MAX = 10_000;

test("the minutely sweep keeps what is under 10 minutes old in each map", () => {
  const s = new AppSignIns();
  s.add("old", "a_1", T0);
  s.passed("code-old", "old", true, T0);
  s.start("old", "tok-old", T0);
  s.add("new", "a_1", T0 + 60_000);
  s.passed("code-new", "new", true, T0 + 60_000);
  s.start("new", "tok-new", T0 + 60_000);

  const now = T0 + APP_SIGN_IN_MS;
  s.sweep(now);
  expect(s.reached("new", "a_1", now)).toBe(true);
  expect(s.challengeOf("code-new", now)).toMatchObject({ challenge: "new", bound: true });
  expect(s.start("new", "again", now)).toBe(false);
  expect(s.takeStartToken("new", "tok-new", now)).toBe(true);
});

test("sweeping frees the room a flood took, so new sign-ins start again", () => {
  const s = new AppSignIns();
  for (let i = 0; i < MAX; i++) {
    s.start(`c${i}`, "t", T0);
    s.passed(`code${i}`, `c${i}`, false, T0);
  }
  // Full: refused rather than forget a live one.
  expect(s.start("late", "t", T0 + 1)).toBe(false);
  expect(s.passed("code-late", "late", false, T0 + 1)).toBe(false);
  s.sweep(T0 + APP_SIGN_IN_MS);
  expect(s.start("late", "t", T0 + APP_SIGN_IN_MS)).toBe(true);
  expect(s.passed("code-late", "late", false, T0 + APP_SIGN_IN_MS)).toBe(true);
});

test("past 10,000 sign-ins the oldest goes, and a repeated one counts as new", () => {
  const s = new AppSignIns();
  for (let i = 0; i < MAX; i++) s.add(`c${i}`, "a_1", T0 + i);
  // Signed in again, c0 moves to the end and c1 is now the oldest.
  s.add("c0", "a_1", T0 + MAX);
  s.add("one-more", "a_1", T0 + MAX + 1);
  const now = T0 + MAX + 2;
  expect(s.reached("c1", "a_1", now)).toBe(false);
  expect(s.reached("c0", "a_1", now)).toBe(true);
  expect(s.reached("c2", "a_1", now)).toBe(true);
  expect(s.reached("one-more", "a_1", now)).toBe(true);
});

test("deleting an account forgets its app sign-ins and no one else's (#1104)", async () => {
  const s = await makeServer();
  const gone = await setupAccount(s, "phone");
  s.deps.appSignIns.add("theirs", gone.id);
  s.deps.appSignIns.add("other", "a_other");
  expect(s.deps.appSignIns.reached("theirs", gone.id)).toBe(true);

  expect((await s.call("DELETE", "/v1/account", { token: gone.device.token })).status).toBe(204);
  expect(s.deps.appSignIns.reached("theirs", gone.id)).toBe(false);
  expect(s.deps.appSignIns.reached("other", "a_other")).toBe(true);
});
