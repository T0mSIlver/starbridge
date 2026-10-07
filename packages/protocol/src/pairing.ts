import { z } from "zod";
import type { Directory } from "./directory";
import { parseWith } from "./envelope";
import { B64, Id, Role, Time } from "./schemas";
import { concat, fromB64, ProtocolError, sodium, toB64, utf8 } from "./sodium";

/**
 * Pairing joins a new member (a machine, or another device) to the directory.
 *
 * The new member shows a 24-character code: 8 characters of rendezvous id, which the server
 * sees, and 16 characters (80 bits) of secret, which never reaches the server. Both sides
 * authenticate their messages with a key derived from the secret, so the server can neither
 * swap the new member's keys nor hand the new member a directory of its own.
 */

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface PairingCode {
  rendezvous: string;
  secret: string;
}

export function newPairingCode(): PairingCode {
  return splitCode(encodeCrockford(sodium.randombytes_buf(15)));
}

export function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** Characters from `CROCKFORD` to bytes, MSB first; bits past the last whole byte drop. */
export function decodeCrockford(chars: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of chars) {
    const v = CROCKFORD.indexOf(c);
    if (v < 0) throw new ProtocolError("bad-encoding", "not Crockford base32");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

function splitCode(chars: string): PairingCode {
  return { rendezvous: chars.slice(0, 8), secret: chars.slice(8, 24) };
}

/** "ABCD-EFGH-…", six groups of four. */
export function formatPairingCode(code: PairingCode): string {
  return (code.rendezvous + code.secret).match(/.{4}/g)?.join("-") ?? "";
}

/** Accepts any case, dashes and spaces, and Crockford's look-alikes (O for 0, I and L for 1). */
export function parsePairingCode(text: string): PairingCode {
  const chars = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (chars.length !== 24 || [...chars].some((c) => !CROCKFORD.includes(c)))
    throw new ProtocolError("bad-encoding", "pairing code must be 24 Crockford base32 characters");
  return splitCode(chars);
}

/**
 * The link a QR code carries: `<server>/pair#<code>`. Opened in a browser, it shows the web page
 * with the code filled in; the fragment never reaches the server.
 */
export function pairingLink(server: string, code: PairingCode): string {
  return `${server.replace(/\/+$/, "")}/pair#${formatPairingCode(code)}`;
}

/** A code typed by hand, or read from a scanned pairing link: the part after `#` if any. */
export function codeFromLink(text: string): PairingCode {
  const hash = text.indexOf("#");
  return parsePairingCode(hash >= 0 ? text.slice(hash + 1) : text);
}

/**
 * The new member's claim secret, sent as `X-Claim` to fetch its approval and machine token:
 * 32 random bytes, base64url. The server keeps only `claimHash` of it.
 */
export function newClaimSecret(): string {
  return toB64(sodium.randombytes_buf(32));
}

/** BLAKE2b-256 of the claim secret's text, base64url: `claimHash` in `POST /pairings`. */
export function claimHash(secret: string): string {
  return toB64(sodium.crypto_generichash(32, utf8(secret), null));
}

/** BLAKE2b-256 of "starbridge/v1/pairing-key", NUL, the 16 secret characters. */
export function pairingKey(code: PairingCode): Uint8Array {
  return sodium.crypto_generichash(
    32,
    concat(utf8("starbridge/v1/pairing-key"), new Uint8Array([0]), utf8(code.secret)),
    null,
  );
}

export const PairingRequestBody = z.object({
  v: z.literal(1),
  rendezvous: z.string().length(8),
  role: Role,
  id: Id,
  name: z.string().min(1).max(100),
  boxPk: B64,
  signPk: B64,
  at: Time,
});
export type PairingRequestBody = z.infer<typeof PairingRequestBody>;

export const PairingApprovalBody = z.object({
  v: z.literal(1),
  rendezvous: z.string().length(8),
  account: Id,
  /** The directory up to and including the new member's entry. */
  length: z.number().int().positive(),
  head: B64,
  approver: Id,
});
export type PairingApprovalBody = z.infer<typeof PairingApprovalBody>;

/** A pairing message: JSON body text plus its HMAC-SHA-512-256 (`crypto_auth`). */
export const PairingMessage = z.object({ body: z.string(), mac: B64 });
export type PairingMessage = z.infer<typeof PairingMessage>;

type PairingKind = "pairing-request" | "pairing-approval";

function macMessage(kind: PairingKind, body: string): Uint8Array {
  return concat(utf8(`starbridge/v1/${kind}`), new Uint8Array([0]), utf8(body));
}

function authenticate(kind: PairingKind, body: object, code: PairingCode): PairingMessage {
  const text = JSON.stringify(body);
  return { body: text, mac: toB64(sodium.crypto_auth(macMessage(kind, text), pairingKey(code))) };
}

function check(kind: PairingKind, msg: unknown, code: PairingCode): unknown {
  const m = parseWith(PairingMessage, msg);
  let ok = false;
  try {
    ok = sodium.crypto_auth_verify(fromB64(m.mac), macMessage(kind, m.body), pairingKey(code));
  } catch {
    ok = false;
  }
  if (!ok) throw new ProtocolError("bad-mac", kind);
  try {
    return JSON.parse(m.body);
  } catch {
    throw new ProtocolError("bad-schema", "body is not JSON");
  }
}

/** Made by the new member and posted to the server under the rendezvous id. */
export function pairingRequest(body: PairingRequestBody, code: PairingCode): PairingMessage {
  if (body.rendezvous !== code.rendezvous) throw new Error("rendezvous differs from the code");
  return authenticate("pairing-request", parseWith(PairingRequestBody, body), code);
}

/** Checked by the approving device after the owner types the code. */
export function openPairingRequest(msg: unknown, code: PairingCode): PairingRequestBody {
  const body = parseWith(PairingRequestBody, check("pairing-request", msg, code));
  if (body.rendezvous !== code.rendezvous) throw new ProtocolError("id-mismatch", "rendezvous");
  return body;
}

/** Made by the approving device once the new member's entry is in the directory. */
export function pairingApproval(body: PairingApprovalBody, code: PairingCode): PairingMessage {
  return authenticate("pairing-approval", parseWith(PairingApprovalBody, body), code);
}

/** Checked by the new member; it then verifies the directory with `{ length, head }` as pin. */
export function openPairingApproval(msg: unknown, code: PairingCode): PairingApprovalBody {
  const body = parseWith(PairingApprovalBody, check("pairing-approval", msg, code));
  if (body.rendezvous !== code.rendezvous) throw new ProtocolError("id-mismatch", "rendezvous");
  return body;
}

/** After pairing: the verified directory must hold the new member, active, with its own keys. */
export function checkJoined(
  dir: Directory,
  me: { id: string; boxPk: string; signPk: string; role: z.infer<typeof Role> },
): void {
  const entry = dir.members.get(me.id);
  if (
    !entry?.active ||
    entry.member.role !== me.role ||
    entry.member.boxPk !== me.boxPk ||
    entry.member.signPk !== me.signPk
  )
    throw new ProtocolError("unknown-member", "the directory does not hold my keys");
}

// --- Binding a new session ---------------------------------------------------

/**
 * What a device signs to bind a fresh session to its member, after signing in again:
 * "starbridge/v1/bind", NUL, account, NUL, member id, NUL, the server's nonce. The account and
 * member keep a signature for one binding from serving another; the nonce is single-use.
 */
export function bindMessage(account: string, member: string, nonce: string): Uint8Array {
  const nul = new Uint8Array([0]);
  return concat(
    utf8("starbridge/v1/bind"),
    nul,
    utf8(account),
    nul,
    utf8(member),
    nul,
    utf8(nonce),
  );
}

/** True when `signPk` signed this binding. */
export function verifyBind(
  args: { account: string; member: string; nonce: string; sig: string },
  signPk: string,
): boolean {
  try {
    return sodium.crypto_sign_verify_detached(
      fromB64(args.sig),
      bindMessage(args.account, args.member, args.nonce),
      fromB64(signPk),
    );
  } catch {
    return false;
  }
}

/**
 * A machine's check code, which the machine asks the owner to confirm against the code a device
 * shows beside it under Devices (#795): the first 80 bits of BLAKE2b-256("starbridge/v1/check"
 * NUL boxPk signPk), as 16 Crockford base32 characters in groups of four. A machine paired into
 * a chain the server controls is missing from the owner's, or stands there as a stand-in with a
 * key of the server's, whose code the server would have to grind to the machine's.
 */
export function checkCode(keys: { boxPk: string; signPk: string }): string {
  const box = fromB64(keys.boxPk);
  const sign = fromB64(keys.signPk);
  if (box.length !== 32 || sign.length !== 32)
    throw new ProtocolError("bad-encoding", "a public key is not 32 bytes");
  const hash = sodium.crypto_generichash(
    32,
    concat(utf8("starbridge/v1/check"), new Uint8Array([0]), box, sign),
    null,
  );
  return (encodeCrockford(hash.subarray(0, 10)).match(/.{4}/g) as string[]).join("-");
}
