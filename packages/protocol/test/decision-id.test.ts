import { expect, test } from "bun:test";
import { DECISION_ID_WORDS, Id, newDecisionId } from "../src";
import { WORDS } from "../src/words";

test("the list is the 2048 words of BIP-39, each told apart by four letters", () => {
  expect(WORDS).toHaveLength(2048);
  expect(WORDS.slice(0, 2)).toEqual(["abandon", "ability"]);
  expect(WORDS.at(-1)).toBe("zoo");
  expect(new Set(WORDS).size).toBe(2048);
  expect(new Set(WORDS.map((w) => w.slice(0, 4))).size).toBe(2048);
  expect(WORDS.every((w) => /^[a-z]{3,8}$/.test(w))).toBe(true);
});

test("an id is d_ and four words, and an Id", () => {
  for (let i = 0; i < 200; i++) {
    const id = newDecisionId();
    expect(id).toMatch(/^d_[a-z]+(-[a-z]+){3}$/);
    expect(id.slice(2).split("-").length).toBe(DECISION_ID_WORDS);
    expect(Id.safeParse(id).success).toBe(true);
  }
});

test("each 11 bits pick one word", () => {
  const word = (hi: number, lo: number) =>
    newDecisionId(() => new Uint8Array([hi, lo, 0, 0, 0, 0, 0, 0])).split("-")[0];
  expect(word(0, 0)).toBe("d_abandon");
  expect(word(0xf8, 0xff)).toBe(`d_${WORDS[0xff]}`); // the top 5 bits of two bytes are dropped
  expect(word(0xff, 0xff)).toBe("d_zoo");
});

test("ids differ", () => {
  expect(new Set(Array.from({ length: 2000 }, () => newDecisionId())).size).toBe(2000);
});
