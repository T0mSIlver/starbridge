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

/** A fresh recovery seed: 16 bytes, shown once as a recovery key (`recoveryKey`). */
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
  /** Characters of the key, separators aside. */
  count: number;
  problem: RecoveryKeyProblem | null;
}

export class RecoveryKeyError extends Error {
  constructor(readonly reading: RecoveryKeyReading) {
    super("recovery key is not valid");
  }
}

/** Any case, with or without dashes and spaces; Crockford's look-alikes (O for 0, I and L for 1). */
function keyChars(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/**
 * Reads typed text as a recovery key. With `typing`, only a character no key holds counts: more
 * typing fixes a short key.
 */
export function readRecoveryKey(text: string, opts: { typing?: boolean } = {}): RecoveryKeyReading {
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
  return { count: chars.length, problem };
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

/** The seed behind a typed recovery key. Throws `RecoveryKeyError`. */
export function recoverySeedFromKey(text: string): Uint8Array {
  const reading = readRecoveryKey(text);
  if (reading.problem) throw new RecoveryKeyError(reading);
  return seedOf(keyChars(text));
}

/**
 * The recovery signing key pair: the 16-byte seed stretched to the 32 bytes Ed25519 takes with
 * BLAKE2b-256 of "starbridge/v1/recovery-seed", NUL, the seed.
 */
export function recoveryKeyPair(seed: Uint8Array): KeyPair {
  if (seed.length !== 16) throw new Error("a recovery seed is 16 bytes");
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
