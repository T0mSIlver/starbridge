import sodium from "libsodium-wrappers";

/** Resolves once libsodium's WebAssembly is loaded. Await it before any other call. */
export const ready: Promise<void> = sodium.ready;

export { sodium };

const B64 = /^[A-Za-z0-9_-]*$/;

/** Base64url without padding, the only binary encoding on the wire. */
export function toB64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function fromB64(text: string): Uint8Array {
  if (!B64.test(text)) throw new ProtocolError("bad-encoding", "not base64url without padding");
  return sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Error codes are part of the protocol: the test vectors name them, and the Kotlin client
 * reports the same ones.
 */
export type ErrorCode =
  | "bad-encoding"
  | "bad-schema"
  | "bad-signature"
  | "bad-mac"
  | "bad-commitment"
  | "bad-key"
  | "cannot-open"
  | "wrong-kind"
  | "wrong-recipient"
  | "id-mismatch"
  | "unknown-signer"
  | "revoked-signer"
  | "signer-not-allowed"
  | "bad-genesis"
  | "bad-chain"
  | "duplicate-member"
  | "unknown-member"
  | "wrong-account"
  | "rollback";

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProtocolError";
  }
}
