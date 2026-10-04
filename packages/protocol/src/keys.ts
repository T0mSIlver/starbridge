import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { sodium, toB64 } from "./sodium";

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

/** A fresh 32-byte recovery seed, shown once as 24 BIP-39 English words. */
export function generateRecoverySeed(): Uint8Array {
  return sodium.randombytes_buf(32);
}

export function recoveryWords(seed: Uint8Array): string {
  return entropyToMnemonic(seed, wordlist);
}

/** Throws on a typo: BIP-39 words carry a checksum. */
export function recoverySeedFromWords(words: string): Uint8Array {
  const normalized = words.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(normalized, wordlist)) throw new Error("recovery words are not valid");
  return mnemonicToEntropy(normalized, wordlist);
}

export function recoveryKeyPair(seed: Uint8Array): KeyPair {
  return sodium.crypto_sign_seed_keypair(seed);
}
