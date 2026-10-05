import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { CROCKFORD, decodeCrockford, encodeCrockford } from "./pairing";
import { concat, sodium, toB64, utf8 } from "./sodium";

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** A device's or machine's keys. The private halves never leave it. */
export interface MemberKeys {
  box: KeyPair;
  sign: KeyPair;
}

export function generateMemberKeys(): MemberKeys {
  return { box: sodium.crypto_box_keypair(), sign: sodium.crypto_sign_keypair() };
}

/** Deterministic keys from 32-byte seeds, for test vectors. */
export function memberKeysFromSeeds(boxSeed: Uint8Array, signSeed: Uint8Array): MemberKeys {
  return {
    box: sodium.crypto_box_seed_keypair(boxSeed),
    sign: sodium.crypto_sign_seed_keypair(signSeed),
  };
}

export function publicKeys(keys: MemberKeys): { boxPk: string; signPk: string } {
  return { boxPk: toB64(keys.box.publicKey), signPk: toB64(keys.sign.publicKey) };
}

// --- Recovery key ------------------------------------------------------------

/**
 * A fresh recovery seed: 16 bytes, shown once as a recovery key (`recoveryKey`). Accounts made
 * before 2026-10-06 were shown words instead: 24 BIP-39 words for a 32-byte seed, 12 for a
 * 16-byte one. All three recover (`readRecoveryKey`).
 */
export function generateRecoverySeed(): Uint8Array {
  return sodium.randombytes_buf(16);
}

const KEY_CHARS = 28;

/** The 12-bit check: the first 12 bits of BLAKE2b-256 of "starbridge/v1/recovery-check", NUL, the seed. */
function keyCheck(seed: Uint8Array): Uint8Array {
  const h = sodium.crypto_generichash(
    32,
    concat(utf8("starbridge/v1/recovery-check"), new Uint8Array([0]), seed),
    null,
  );
  return new Uint8Array([h[0] as number, (h[1] as number) & 0xf0]);
}

/**
 * The recovery key people write down: the 16-byte seed and its 12-bit check, 140 bits, as 28
 * Crockford base32 characters in seven groups of four ("7KQ2-M9XD-…").
 */
export function recoveryKey(seed: Uint8Array): string {
  if (seed.length !== 16) throw new Error("a recovery key holds a 16-byte seed");
  const chars = encodeCrockford(concat(seed, keyCheck(seed))).slice(0, KEY_CHARS);
  return chars.match(/.{4}/g)?.join("-") ?? "";
}

/** What is wrong with a typed recovery key; `index` counts characters from 0, separators aside. */
export type RecoveryKeyProblem =
  | { kind: "bad-character"; index: number; char: string }
  | { kind: "length"; count: number }
  | { kind: "checksum" };

export interface RecoveryKeyReading {
  /** Old accounts recover with words; the text looks like words rather than a key. */
  format: "key" | "words";
  /** Characters of a key, or words. */
  count: number;
  problem: RecoveryKeyProblem | RecoveryWordsProblem | null;
}

export class RecoveryKeyError extends Error {
  constructor(readonly reading: RecoveryKeyReading) {
    super("recovery key is not valid");
  }
}

/**
 * Words, not a key: a run of 5 to 8 letters that a separator ends (BIP-39 words are 3 to 8
 * letters; a key's groups are 4), or 8 or more runs of 3 letters or more.
 */
function looksLikeWords(text: string): boolean {
  if (/(^|[^\p{L}\p{N}])\p{L}{5,8}[^\p{L}\p{N}]/u.test(text)) return true;
  return (text.match(/(?<![\p{L}\p{N}])\p{L}{3,}(?![\p{L}\p{N}])/gu) ?? []).length >= 8;
}

/** Any case, with or without dashes and spaces; Crockford's look-alikes (O for 0, I and L for 1). */
function keyChars(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/**
 * Reads typed text as a recovery key, or as the words of an older account. With `typing`, only
 * problems that more typing cannot fix count: a character no key holds, or a finished word that
 * is not on the list.
 */
export function readRecoveryKey(text: string, opts: { typing?: boolean } = {}): RecoveryKeyReading {
  if (looksLikeWords(text)) {
    const words = splitRecoveryWords(text);
    // The last word is still being typed unless a separator follows it.
    const finished = opts.typing && /\p{L}$/u.test(text) ? words.slice(0, -1) : words;
    const problem = recoveryWordsProblem(finished);
    return {
      format: "words",
      count: words.length,
      problem: opts.typing && problem?.kind !== "unknown-word" ? null : problem,
    };
  }
  const chars = keyChars(text);
  const index = [...chars].findIndex((c) => !CROCKFORD.includes(c));
  const problem: RecoveryKeyProblem | null =
    index >= 0
      ? { kind: "bad-character", index, char: chars[index] as string }
      : opts.typing
        ? null
        : chars.length !== KEY_CHARS
          ? { kind: "length", count: chars.length }
          : checks(chars)
            ? null
            : { kind: "checksum" };
  return { format: "key", count: chars.length, problem };
}

/** 28 characters are 140 bits: one padding character brings the check's last 4 bits into byte 17. */
const keyBytes = (chars: string) => decodeCrockford(`${chars}0`);

function seedOf(chars: string): Uint8Array {
  return keyBytes(chars).slice(0, 16);
}

function checks(chars: string): boolean {
  const bytes = keyBytes(chars);
  const check = keyCheck(bytes.slice(0, 16));
  return bytes[16] === check[0] && ((bytes[17] as number) & 0xf0) === check[1];
}

/** The seed behind a typed recovery key or older account's words. Throws `RecoveryKeyError`. */
export function recoverySeedFromKey(text: string): Uint8Array {
  const reading = readRecoveryKey(text);
  if (reading.problem) throw new RecoveryKeyError(reading);
  if (reading.format === "words")
    return mnemonicToEntropy(splitRecoveryWords(text).join(" "), wordlist);
  return seedOf(keyChars(text));
}

export function recoveryWords(seed: Uint8Array): string {
  return entropyToMnemonic(seed, wordlist);
}

/** What is wrong with typed recovery words; `index` counts from 0. */
export type RecoveryWordsProblem =
  | { kind: "unknown-word"; index: number; word: string }
  | { kind: "word-count"; count: number }
  | { kind: "checksum" };

export class RecoveryWordsError extends Error {
  constructor(readonly problem: RecoveryWordsProblem) {
    super("recovery words are not valid");
  }
}

/**
 * The words in typed text, lowercased. Anything that is not a letter separates words, so spaces,
 * dashes, commas, line breaks and numbering ("1.", "2)") all work.
 */
export function splitRecoveryWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w !== "");
}

const known = new Set(wordlist);

/** The first unknown word, else a count other than 12 or 24, else a failed checksum. */
export function recoveryWordsProblem(words: string[]): RecoveryWordsProblem | null {
  const index = words.findIndex((w) => !known.has(w));
  if (index >= 0) return { kind: "unknown-word", index, word: words[index] as string };
  if (words.length !== 12 && words.length !== 24)
    return { kind: "word-count", count: words.length };
  if (!validateMnemonic(words.join(" "), wordlist)) return { kind: "checksum" };
  return null;
}

/** The seed behind typed words. Throws `RecoveryWordsError`: BIP-39 words carry a checksum. */
export function recoverySeedFromWords(text: string): Uint8Array {
  const words = splitRecoveryWords(text);
  const problem = recoveryWordsProblem(words);
  if (problem) throw new RecoveryWordsError(problem);
  return mnemonicToEntropy(words.join(" "), wordlist);
}

/**
 * The recovery signing key pair. A 32-byte seed is the Ed25519 seed itself; a 16-byte one is
 * stretched to the 32 bytes Ed25519 takes with BLAKE2b-256 of "starbridge/v1/recovery-seed",
 * NUL, the seed.
 */
export function recoveryKeyPair(seed: Uint8Array): KeyPair {
  if (seed.length === 32) return sodium.crypto_sign_seed_keypair(seed);
  if (seed.length !== 16) throw new Error("a recovery seed is 16 or 32 bytes");
  const stretched = sodium.crypto_generichash(
    32,
    concat(utf8("starbridge/v1/recovery-seed"), new Uint8Array([0]), seed),
    null,
  );
  try {
    return sodium.crypto_sign_seed_keypair(stretched);
  } finally {
    stretched.fill(0);
  }
}
