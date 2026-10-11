import { beforeAll, expect, test } from "bun:test";
import {
  generateRecoverySeed,
  RecoveryKeyError,
  readRecoveryKey,
  ready,
  recoveryKey,
  recoveryKeyPair,
  recoverySeedFromKey,
} from "../src";
import keys from "../vectors/keys.json";

const key = keys.recovery.key;
// Read once libsodium is loaded: at module load it may not be yet (#1256).
let seed: Uint8Array;
beforeAll(async () => {
  await ready;
  seed = recoverySeedFromKey(key);
});

test("a new account gets a key of seven groups of four", () => {
  expect(recoveryKey(generateRecoverySeed())).toMatch(
    /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/,
  );
});

test.each([
  ["lower case", key.toLowerCase()],
  ["no dashes", key.replace(/-/g, "")],
  ["spaces", key.replace(/-/g, " ")],
  ["look-alikes", key.replace(/0/g, "O").replace(/1/g, "l")],
])("the key reads with %s", (_, text) => {
  expect(recoverySeedFromKey(text)).toEqual(seed);
});

test("points at a character no key holds", () => {
  const typo = `${key.slice(0, 5)}U${key.slice(6)}`;
  expect(readRecoveryKey(typo).problem).toEqual({ kind: "bad-character", index: 4, char: "U" });
});

test("a wrong character fails the check", () => {
  const typo = `${key.slice(0, 5)}${key[5] === "2" ? "3" : "2"}${key.slice(6)}`;
  expect(readRecoveryKey(typo).problem).toEqual({ kind: "checksum" });
  expect(() => recoverySeedFromKey(typo)).toThrow(RecoveryKeyError);
});

test("while typing, only a character no key holds counts", () => {
  expect(readRecoveryKey("7KQU", { typing: true }).problem).toEqual({
    kind: "bad-character",
    index: 3,
    char: "U",
  });
  expect(readRecoveryKey(key.slice(0, 9), { typing: true })).toEqual({ count: 8, problem: null });
  expect(readRecoveryKey(key.slice(0, 9)).problem).toEqual({ kind: "length", count: 8 });
});

test("the recovery key takes a 16-byte seed only", () => {
  expect(() => recoveryKeyPair(new Uint8Array(32))).toThrow();
});
