// This device's keys. Where the browser supports X25519 and Ed25519 in WebCrypto, the private
// keys are non-extractable CryptoKeys: script on the page can use them but never read them, and
// IndexedDB stores them as opaque handles. Elsewhere they fall back to raw libsodium keys.
import { hsalsa } from "@noble/ciphers/salsa.js";
import type { OpenSealFn, SignFn } from "@starbridge/protocol";
import sodium from "libsodium-wrappers";

export type StoredKeys =
  | { kind: "webcrypto"; box: CryptoKey; sign: CryptoKey }
  | { kind: "raw"; boxSk: Uint8Array; signSk: Uint8Array };

export interface DeviceKeys {
  boxPk: Uint8Array;
  signPk: Uint8Array;
  stored: StoredKeys;
}

async function webCryptoKeys(): Promise<DeviceKeys> {
  const box = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    boxPk: new Uint8Array(await crypto.subtle.exportKey("raw", box.publicKey)),
    signPk: new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey)),
    stored: { kind: "webcrypto", box: box.privateKey, sign: sign.privateKey },
  };
}

/** `keeps` checks that storage gives WebCrypto keys back; raw keys replace any it loses. */
export async function generateDeviceKeys(
  keeps: (keys: StoredKeys) => Promise<boolean> = async () => true,
): Promise<DeviceKeys> {
  try {
    const keys = await webCryptoKeys();
    if (!(await keeps(keys.stored))) throw new Error("storage loses WebCrypto keys");
    return keys;
  } catch {
    await sodium.ready;
    const box = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();
    return {
      boxPk: box.publicKey,
      signPk: sign.publicKey,
      stored: { kind: "raw", boxSk: box.privateKey, signSk: sign.privateKey },
    };
  }
}

export function signer(stored: StoredKeys): SignFn {
  if (stored.kind === "raw")
    return async (message) => {
      await sodium.ready;
      return sodium.crypto_sign_detached(message, stored.signSk);
    };
  return async (message) =>
    new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, stored.sign, message as BufferSource),
    );
}

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function words(bytes: Uint8Array): Uint32Array {
  const out = new Uint32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

function bytes(w: Uint32Array): Uint8Array {
  const out = new Uint8Array(w.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < w.length; i++) view.setUint32(i * 4, w[i] as number, true);
  return out;
}

/**
 * `crypto_box_seal_open` with the X25519 step done by WebCrypto, so the private key stays inside
 * it. The rest is libsodium's sealed box: the ephemeral public key leads the box, the nonce is
 * BLAKE2b-192(epk || pk), and the box key is HSalsa20(shared secret, zero nonce), which is what
 * `crypto_box_beforenm` computes. libsodium.js's standard build lacks HSalsa20, so it comes from
 * @noble/ciphers (audited).
 */
async function openSealWebCrypto(
  box: Uint8Array,
  myPk: Uint8Array,
  sk: CryptoKey,
): Promise<Uint8Array> {
  await sodium.ready;
  if (box.length < sodium.crypto_box_SEALBYTES) throw new Error("box too short");
  const epk = box.subarray(0, 32);
  const peer = await crypto.subtle.importKey(
    "raw",
    epk as BufferSource,
    { name: "X25519" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "X25519", public: peer }, sk, 256),
  );
  const key = new Uint32Array(8);
  hsalsa(SIGMA, words(shared), new Uint32Array(4), key);
  shared.fill(0);
  const nonce = sodium.crypto_generichash(24, sodium_concat(epk, myPk), null);
  const k = bytes(key);
  try {
    return sodium.crypto_box_open_easy_afternm(box.subarray(32), nonce, k);
  } finally {
    k.fill(0);
    key.fill(0);
  }
}

function sodium_concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function sealOpener(stored: StoredKeys, boxPk: Uint8Array): OpenSealFn {
  if (stored.kind === "raw")
    return async (box) => {
      await sodium.ready;
      return sodium.crypto_box_seal_open(box, boxPk, stored.boxSk);
    };
  return (box) => openSealWebCrypto(box, boxPk, stored.box);
}
