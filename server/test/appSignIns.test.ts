import { expect, test } from "bun:test";
import { APP_SIGN_IN_MS, AppSignIns, PER_ADDRESS } from "../src/appSignIns";
import { makeServer, setupAccount } from "../test-support/app";

const T0 = 1_000_000;
/** Sign-ins kept at once (appSignIns.ts). */
const MAX = 10_000;

test("the minutely sweep keeps what is under 10 minutes old in each map", () => {
  const s = new AppSignIns();
  s.add("old", "a_1", T0);
  s.passed("code-old", "old", true, "1.2.3.4", T0);
  s.start("old", "tok-old", "1.2.3.4", T0);
  s.add("new", "a_1", T0 + 60_000);
  s.passed("code-new", "new", true, "1.2.3.4", T0 + 60_000);
  s.start("new", "tok-new", "1.2.3.4", T0 + 60_000);

  const now = T0 + APP_SIGN_IN_MS;
  s.sweep(now);
  expect(s.reached("new", "a_1", now)).toBe(true);
  expect(s.challengeOf("code-new", now)).toMatchObject({ challenge: "new", bound: true });
  expect(s.start("new", "again", "1.2.3.4", now)).toBe(false);
  expect(s.takeStartToken("new", "tok-new", now)).toBe(true);
});

/** The address a flood's `i`th entry comes from: `PER_ADDRESS` entries each. */
const flooder = (i: number) =>
  `10.0.${Math.floor(i / PER_ADDRESS / 256)}.${Math.floor(i / PER_ADDRESS) % 256}`;

test("one address keeps its share and no more; the next address still signs in", () => {
  const s = new AppSignIns();
  for (let i = 0; i < PER_ADDRESS; i++) {
    expect(s.start(`c${i}`, "t", "1.2.3.4", T0)).toBe(true);
    expect(s.passed(`code${i}`, `c${i}`, false, "1.2.3.4", T0)).toBe(true);
  }
  expect(s.start("late", "t", "1.2.3.4", T0 + 1)).toBe(false);
  expect(s.passed("code-late", "late", false, "1.2.3.4", T0 + 1)).toBe(false);
  expect(s.start("late", "t", "2001:db8:1::/48", T0 + 1)).toBe(true);
  expect(s.passed("code-late", "late", false, "2001:db8:1::/48", T0 + 1)).toBe(true);
});

test("a flood from many addresses fills the maps, and a new address still signs in (L6)", () => {
  const s = new AppSignIns();
  for (let i = 0; i < MAX; i++) {
    s.start(`c${i}`, "t", flooder(i), T0);
    s.passed(`code${i}`, `c${i}`, false, flooder(i), T0);
  }
  // Full: room comes from an address that keeps more, never from the one asking.
  expect(s.start("late", "t", "1.2.3.4", T0 + 1)).toBe(true);
  expect(s.passed("code-late", "late", false, "1.2.3.4", T0 + 1)).toBe(true);
  expect(s.challengeOf("code-late", T0 + 1)).toMatchObject({ challenge: "late" });
  // Addresses tie at the most: the newest one's oldest entry made the room, not the earliest's.
  const newest = Math.floor((MAX - 1) / PER_ADDRESS) * PER_ADDRESS;
  expect(s.challengeOf(`code${newest}`, T0 + 1)).toBeUndefined();
  expect(s.challengeOf("code0", T0 + 1)).toMatchObject({ challenge: "c0" });
  expect(s.challengeOf("code1", T0 + 1)).toMatchObject({ challenge: "c1" });
  // A flooding address gets no more for itself.
  expect(s.start("again", "t", flooder(PER_ADDRESS), T0 + 1)).toBe(false);
  s.sweep(T0 + APP_SIGN_IN_MS);
  expect(s.challengeOf("code1", T0 + APP_SIGN_IN_MS)).toBeUndefined();
  expect(s.start("after", "t", flooder(0), T0 + APP_SIGN_IN_MS)).toBe(true);
});

test("an address above the always-kept share, ahead of a flood that ties it, keeps its code", () => {
  const s = new AppSignIns();
  for (let i = 0; i < 6; i++) s.passed(`p${i}`, `pc${i}`, false, "203.0.113.7", T0);
  // The flood's addresses keep 6 each, as many as the person does.
  for (let i = 0; i < MAX - 6; i++)
    s.passed(
      `code${i}`,
      `c${i}`,
      false,
      `10.1.${Math.floor(i / 6 / 256)}.${Math.floor(i / 6) % 256}`,
      T0,
    );
  expect(s.start("late", "t", "1.2.3.4", T0 + 1)).toBe(true);
  expect(s.passed("code-late", "late", false, "1.2.3.4", T0 + 1)).toBe(true);
  expect(s.challengeOf("p0", T0 + 1)).toMatchObject({ challenge: "pc0" });
});

test("a flood never drops a person's live code, whoever asks for room", () => {
  const s = new AppSignIns();
  expect(s.passed("victim", "theirs", true, "203.0.113.9", T0)).toBe(true);
  for (let i = 0; i < MAX - 1; i++) s.passed(`code${i}`, `c${i}`, false, flooder(i), T0);
  // Fresh addresses keep asking: room comes from the flood, never the person's code.
  for (let i = 0; i < 2 * PER_ADDRESS; i++)
    s.passed(`late${i}`, `l${i}`, false, `198.51.100.${i}`, T0 + 1);
  expect(s.challengeOf("victim", T0 + 1)).toMatchObject({ challenge: "theirs" });
  expect(s.passed("victim", "attackers", false, "192.0.2.1", T0 + 1)).toBe(false);
});

test("a full map never drops a live code for an address that keeps as many", () => {
  const s = new AppSignIns();
  for (let i = 0; i < MAX; i++) s.passed(`code${i}`, `c${i}`, false, flooder(i), T0);
  // Every address keeps its full share: the caught code stays, and the flood gets no room.
  expect(s.passed("code-new", "new", false, flooder(0), T0 + 1)).toBe(false);
  expect(s.challengeOf("code0", T0 + 1)).toMatchObject({ challenge: "c0" });
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
