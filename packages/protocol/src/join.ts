import { z } from "zod";
import { parseWith } from "./envelope";
import type { KeyPair } from "./keys";
import { encodeCrockford, PairingMessage } from "./pairing";
import { B64, Id, Time } from "./schemas";
import { concat, fromB64, ProtocolError, sodium, toB64, utf8 } from "./sodium";

/**
 * Joining by digits: a device signed in to the account asks to join, and the owner approves it
 * from a device the account already has by checking that both screens show the same 6 digits.
 * No code is typed, so nothing secret is shared beforehand; the two devices agree on a key with
 * X25519 instead, and the digits confirm that the server did not sit in the middle.
 *
 * The digits are a short authentication string (SAS) with a commitment, as in ZRTP and Matrix's
 * SAS verification. The joining device commits to its ephemeral key before it sees the
 * approver's, and reveals it only after: a server in the middle must pick its key for one side
 * before it learns the other side's, so it gets one guess in a million per attempt.
 *
 * 1. The joining device posts its request and `commitment` = BLAKE2b-256("starbridge/v1/
 *    join-commit", NUL, its ephemeral public key, the request text).
 * 2. The approving device posts its own ephemeral public key.
 * 3. The joining device posts its ephemeral public key; the approver checks it against the
 *    commitment.
 * 4. Both derive the MAC key and the digits from the X25519 shared secret and the transcript.
 *    The owner compares the digits, and Approve appends the directory entry and posts an
 *    approval under the MAC key, which the joining device checks as it checks a code's.
 */

export const JoinRequestBody = z.object({
  v: z.literal(1),
  /** 8 Crockford base32 characters, chosen by the joining device. */
  join: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
  account: Id,
  id: Id,
  name: z.string().min(1).max(100),
  boxPk: B64,
  signPk: B64,
  at: Time,
});
export type JoinRequestBody = z.infer<typeof JoinRequestBody>;

export const JoinApprovalBody = z.object({
  v: z.literal(1),
  join: z.string().length(8),
  account: Id,
  /** The directory up to and including the new device's entry. */
  length: z.number().int().positive(),
  head: B64,
  approver: Id,
});
export type JoinApprovalBody = z.infer<typeof JoinApprovalBody>;

/** What a join derives once both ephemeral keys are known. */
export interface JoinKeys {
  /** Keys the approval's `crypto_auth`. */
  mac: Uint8Array;
  /** Six decimal digits, shown on both devices. */
  digits: string;
}

const nul = new Uint8Array([0]);
const label = (name: string) => concat(utf8(`starbridge/v1/${name}`), nul);

export function newJoinId(): string {
  return encodeCrockford(sodium.randombytes_buf(5));
}

/** A fresh X25519 key pair for one join; never reused. */
export function newJoinKeyPair(): KeyPair {
  return sodium.crypto_box_keypair();
}

/** The request text the joining device posts: JSON of the checked body. */
export function joinRequest(body: JoinRequestBody): string {
  return JSON.stringify(parseWith(JoinRequestBody, body));
}

/** Parses the posted request text; the approver shows its name and adds its keys. */
export function openJoinRequest(request: string): JoinRequestBody {
  let value: unknown;
  try {
    value = JSON.parse(request);
  } catch {
    throw new ProtocolError("bad-schema", "request is not JSON");
  }
  return parseWith(JoinRequestBody, value);
}

/** BLAKE2b-256 of "starbridge/v1/join-commit", NUL, the joiner's key, the request text. */
export function joinCommitment(joinerKey: Uint8Array, request: string): string {
  return toB64(
    sodium.crypto_generichash(32, concat(label("join-commit"), joinerKey, utf8(request)), null),
  );
}

function key32(b64: string, what: string): Uint8Array {
  const k = fromB64(b64);
  if (k.length !== 32) throw new ProtocolError("bad-encoding", `${what} is not 32 bytes`);
  return k;
}

function derive(
  mine: KeyPair,
  peer: Uint8Array,
  joinerKey: Uint8Array,
  approverKey: Uint8Array,
  request: string,
): JoinKeys {
  let shared: Uint8Array;
  try {
    shared = sodium.crypto_scalarmult(mine.privateKey, peer);
  } catch {
    // libsodium refuses a result of all zeros: the peer sent a low-order point.
    throw new ProtocolError("bad-key", "the other side's key is not usable");
  }
  if (shared.every((b) => b === 0)) throw new ProtocolError("bad-key", "all-zero shared secret");
  const transcript = concat(joinerKey, approverKey, utf8(request));
  const mac = sodium.crypto_generichash(32, concat(label("join-mac"), transcript), shared);
  const sas = sodium.crypto_generichash(32, concat(label("join-sas"), transcript), shared);
  shared.fill(0);
  const n =
    (((sas[0] ?? 0) << 24) | ((sas[1] ?? 0) << 16) | ((sas[2] ?? 0) << 8) | (sas[3] ?? 0)) >>> 0;
  return { mac, digits: String(n % 1_000_000).padStart(6, "0") };
}

/**
 * The joining device, once the approver's key arrived. It reveals its own key only after this,
 * and only once per join: a second approver key for the same join is refused by the caller.
 */
export function joinerKeys(args: {
  mine: KeyPair;
  approverKey: string;
  request: string;
}): JoinKeys {
  const approverKey = key32(args.approverKey, "approver key");
  return derive(args.mine, approverKey, args.mine.publicKey, approverKey, args.request);
}

/** The approving device, once the joiner revealed its key: it must open the commitment. */
export function approverKeys(args: {
  mine: KeyPair;
  joinerKey: string;
  request: string;
  commitment: string;
}): JoinKeys {
  const joinerKey = key32(args.joinerKey, "joiner key");
  if (joinCommitment(joinerKey, args.request) !== args.commitment)
    throw new ProtocolError("bad-commitment", "the revealed key does not match the commitment");
  return derive(args.mine, joinerKey, joinerKey, args.mine.publicKey, args.request);
}

function approvalMac(body: string, key: Uint8Array): Uint8Array {
  return sodium.crypto_auth(concat(label("join-approval"), utf8(body)), key);
}

/** Made by the approver once the new device's entry is in the directory. */
export function joinApproval(body: JoinApprovalBody, keys: JoinKeys): PairingMessage {
  const text = JSON.stringify(parseWith(JoinApprovalBody, body));
  return { body: text, mac: toB64(approvalMac(text, keys.mac)) };
}

/** Checked by the joining device; it then verifies the directory with `{length, head}` as pin. */
export function openJoinApproval(msg: unknown, keys: JoinKeys, join: string): JoinApprovalBody {
  const m = parseWith(PairingMessage, msg);
  let ok = false;
  try {
    ok = sodium.crypto_auth_verify(
      fromB64(m.mac),
      concat(label("join-approval"), utf8(m.body)),
      keys.mac,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new ProtocolError("bad-mac", "join-approval");
  let value: unknown;
  try {
    value = JSON.parse(m.body);
  } catch {
    throw new ProtocolError("bad-schema", "body is not JSON");
  }
  const body = parseWith(JoinApprovalBody, value);
  if (body.join !== join) throw new ProtocolError("id-mismatch", "join");
  return body;
}

/** "123 456": the digits as both screens show them. */
export function formatDigits(digits: string): string {
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
