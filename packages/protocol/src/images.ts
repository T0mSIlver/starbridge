import type { ImageRef } from "./schemas";
import { concat, fromB64, ProtocolError, sodium, toB64, utf8 } from "./sodium";

const label = concat(utf8("starbridge/v1/image"), new Uint8Array([0]));

function blobHash(blob: Uint8Array): string {
  return toB64(sodium.crypto_generichash(32, concat(label, blob), null));
}

/** Encrypts an image's bytes under a fresh key: the blob to post, and the ref to sign. */
export function sealImage(bytes: Uint8Array): { blob: string; ref: ImageRef } {
  const key = sodium.crypto_secretbox_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const blob = concat(nonce, sodium.crypto_secretbox_easy(bytes, nonce, key));
  return { blob: toB64(blob), ref: { key: toB64(key), hash: blobHash(blob) } };
}

/** The image's bytes, once the blob matches the signed hash and opens under the signed key. */
export function openImage(blob: string, ref: ImageRef): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromB64(blob);
  } catch {
    throw new ProtocolError("cannot-open", "image blob is not base64url");
  }
  if (blobHash(bytes) !== ref.hash) throw new ProtocolError("cannot-open", "image hash differs");
  const n = sodium.crypto_secretbox_NONCEBYTES;
  if (bytes.length < n + sodium.crypto_secretbox_MACBYTES)
    throw new ProtocolError("cannot-open", "image blob too short");
  try {
    return sodium.crypto_secretbox_open_easy(
      bytes.subarray(n),
      bytes.subarray(0, n),
      fromB64(ref.key),
    );
  } catch {
    throw new ProtocolError("cannot-open", "image does not open");
  }
}
