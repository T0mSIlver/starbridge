import { beforeAll, expect, test } from "bun:test";
import {
  generateRecoverySeed,
  RecoveryWordsError,
  type RecoveryWordsProblem,
  ready,
  recoveryKeyPair,
  recoverySeedFromWords,
  recoveryWords,
  recoveryWordsProblem,
  splitRecoveryWords,
} from "../src";
import keys from "../vectors/keys.json";

beforeAll(() => ready);

const twelve = keys.recovery12.words;
const list = twelve.split(" ");

test("a new account gets 12 words", () => {
  expect(recoveryWords(generateRecoverySeed()).split(" ")).toHaveLength(12);
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
