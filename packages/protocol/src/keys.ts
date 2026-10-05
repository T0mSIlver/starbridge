import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
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
 * A fresh recovery seed: 16 bytes, shown once as 12 BIP-39 English words. Accounts made before
 * 2026-10-05 hold a 32-byte seed shown as 24 words; both recover.
 */
export function generateRecoverySeed(): Uint8Array {
  return sodium.randombytes_buf(16);
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
