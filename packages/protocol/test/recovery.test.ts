import { beforeAll, expect, test } from "bun:test";
import {
  generateRecoverySeed,
  RecoveryKeyError,
  RecoveryWordsError,
  type RecoveryWordsProblem,
  readRecoveryKey,
  ready,
  recoveryKey,
  recoveryKeyPair,
  recoverySeedFromKey,
  recoverySeedFromWords,
  recoveryWordsProblem,
  splitRecoveryWords,
} from "../src";
import keys from "../vectors/keys.json";

beforeAll(() => ready);

const twelve = keys.recovery12.words;
const list = twelve.split(" ");

test("a new account gets a key of seven groups of four", () => {
  expect(recoveryKey(generateRecoverySeed())).toMatch(
    /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/,
  );
});

const key = keys.recovery12.key;
const seed = recoverySeedFromKey(key);

test.each([
  ["lower case", key.toLowerCase()],
  ["no dashes", key.replace(/-/g, "")],
  ["spaces", key.replace(/-/g, " ")],
  ["look-alikes", key.replace(/0/g, "O").replace(/1/g, "l")],
  ["words of the same seed", twelve],
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

test("words separated by digits recover", () => {
  expect(recoverySeedFromKey(list.join("1"))).toEqual(recoverySeedFromWords(twelve));
});

test("while typing, only what more typing cannot fix counts", () => {
  // "run" holds a U, which no key does, but the eighth word may still make it words.
  expect(readRecoveryKey("cup run", { typing: true }).problem).toBeNull();
  expect(readRecoveryKey("7KQU", { typing: true }).problem).toEqual({
    kind: "bad-character",
    index: 3,
    char: "U",
  });
  expect(readRecoveryKey(key.slice(0, 9), { typing: true })).toEqual({
    format: "key",
    count: 8,
    problem: null,
  });
  expect(readRecoveryKey(key.slice(0, 9)).problem).toEqual({ kind: "length", count: 8 });
  expect(readRecoveryKey("orbit lanter", { typing: true })).toEqual({
    format: "words",
    count: 2,
    problem: null,
  });
  expect(readRecoveryKey("orbit lanter ", { typing: true }).problem).toEqual({
    kind: "unknown-word",
    index: 1,
    word: "lanter",
  });
});

test.each([
  ["a key", key, "key"],
  ["a key without dashes", key.replace(/-/g, ""), "key"],
  ["24 words", keys.recovery.words, "words"],
  ["12 short words", "able baby cat dog egg fan gap hat ice jar key lab", "words"],
  ["one long word, still typing", "abandon", "key"],
  ["one long word, finished", "abandon ", "words"],
  [
    "words numbered without spaces",
    keys.recovery.words
      .split(" ")
      .map((w, i) => `${i + 1}${w}`)
      .join(""),
    "words",
  ],
])("%s reads as %s", (_, text, format) => {
  expect(readRecoveryKey(text, { typing: true }).format).toBe(format as "key" | "words");
});

test.each([
  ["spaces, any case", twelve.toUpperCase().replace(/ /g, "   ")],
  ["dashes", list.join("-")],
  ["commas", list.join(", ")],
  ["line breaks", `\n${list.join("\r\n")}\n`],
  ["numbering", list.map((w, i) => `${i + 1}. ${w}`).join("\n")],
  ["numbering with parentheses", list.map((w, i) => `${i + 1}) ${w}`).join(" ")],
])("words separated by %s recover", (_, text) => {
  expect(recoverySeedFromWords(text)).toEqual(recoverySeedFromWords(twelve));
});

const problem = (text: string): RecoveryWordsProblem | null =>
  recoveryWordsProblem(splitRecoveryWords(text));

test("points at the first unknown word", () => {
  const typo = [...list];
  typo[4] = "mountian";
  expect(problem(typo.join(" "))).toEqual({ kind: "unknown-word", index: 4, word: "mountian" });
});

test("a count other than 12 or 24 is a count problem", () => {
  expect(problem(list.slice(0, 11).join(" "))).toEqual({ kind: "word-count", count: 11 });
  expect(problem([...list, ...list.slice(0, 6)].join(" "))).toEqual({
    kind: "word-count",
    count: 18,
  });
});

test("two swapped words fail the checksum", () => {
  const swapped = [...list];
  [swapped[0], swapped[1]] = [swapped[1] as string, swapped[0] as string];
  expect(problem(swapped.join(" "))).toEqual({ kind: "checksum" });
  expect(() => recoverySeedFromWords(swapped.join(" "))).toThrow(RecoveryWordsError);
});

test("the recovery key takes a 16- or 32-byte seed only", () => {
  expect(() => recoveryKeyPair(new Uint8Array(24))).toThrow();
});
