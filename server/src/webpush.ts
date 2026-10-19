/**
 * The request a Web Push needs: the payload encrypted for the subscription (RFC 8291, one
 * aes128gcm record as RFC 8188 lays it out) and the VAPID Authorization header (RFC 8292). The
 * caller sends it. Replaces the `web-push` library's `generateRequestDetails` (#2023), with the
 * same headers.
 */

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface WebPushOptions {
  TTL: number;
  urgency: "very-low" | "low" | "normal" | "high";
  vapidDetails?: Vapid;
}

export interface WebPushRequest {
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer> | null;
  endpoint: string;
}

/** The record size written in the header; the whole payload goes in one record. */
const RECORD_SIZE = 4096;
/** A VAPID JWT is valid this long, as `web-push` signed it. */
const JWT_SECONDS = 12 * 60 * 60;

const text = new TextEncoder();

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decodes unpadded base64url, refusing other characters, which `Buffer` would skip. */
function unb64u(s: string, what: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error(`${what} is not base64url`);
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A P-256 key as a JWK, from its uncompressed public point and, for a private key, its scalar. */
export function p256Jwk(publicKey: Uint8Array, privateKey?: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4)
    throw new Error("a P-256 public key must be 65 bytes, uncompressed");
  if (privateKey && privateKey.length !== 32)
    throw new Error("a P-256 private key must be 32 bytes");
  return {
    kty: "EC",
    crv: "P-256",
    x: b64u(publicKey.subarray(1, 33)),
    y: b64u(publicKey.subarray(33)),
    ...(privateKey ? { d: b64u(privateKey) } : {}),
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypts `plaintext` for a subscription's `p256dh` and `auth` (RFC 8291, section 3). The
 * application server's key pair and the salt are fresh for each message; a test passes its own.
 */
export async function encrypt(
  plaintext: Uint8Array,
  p256dh: Uint8Array<ArrayBuffer>,
  auth: Uint8Array<ArrayBuffer>,
  fixed?: { salt: Uint8Array<ArrayBuffer>; publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<Uint8Array<ArrayBuffer>> {
  if (auth.length < 16) throw new Error("the subscription's auth secret must be 16 bytes");
  // The record holds the plaintext, its 0x02 delimiter and the 16-byte tag.
  if (plaintext.length + 17 > RECORD_SIZE) throw new Error("payload too large for one record");
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  const ua = await crypto.subtle.importKey("jwk", p256Jwk(p256dh), ecdh, false, []);
  let asPrivate: CryptoKey;
  let asPublic: Uint8Array<ArrayBuffer>;
  if (fixed) {
    asPublic = new Uint8Array(fixed.publicKey);
    const jwk = p256Jwk(fixed.publicKey, fixed.privateKey);
    asPrivate = await crypto.subtle.importKey("jwk", jwk, ecdh, false, ["deriveBits"]);
  } else {
    const pair = (await crypto.subtle.generateKey(ecdh, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, asPrivate, 256),
  );
  const keyInfo = concat(text.encode("WebPush: info\0"), p256dh, asPublic);
  const ikm = await hkdf(auth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    concat(plaintext, Uint8Array.of(2)),
  );
  // RFC 8188, section 2.1: salt, record size, key id length, key id (our public key).
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, new Uint8Array(sealed));
}

/** The `Authorization` header for a push service at `audience` (RFC 8292, section 3). */
export async function vapidAuthorization(
  audience: string,
  vapid: Vapid,
  now = Date.now(),
): Promise<string> {
  const subject = new URL(vapid.subject);
  if (subject.protocol !== "https:" && subject.protocol !== "mailto:")
    throw new Error("the VAPID subject must be an https: or mailto: URL");
  const jwk = p256Jwk(
    unb64u(vapid.publicKey, "the VAPID public key"),
    unb64u(vapid.privateKey, "the VAPID private key"),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const part = (o: object) => b64u(text.encode(JSON.stringify(o)));
  const claims = { aud: audience, exp: Math.floor(now / 1000) + JWT_SECONDS, sub: vapid.subject };
  const signed = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  // WebCrypto's ECDSA signature is r || s, the form JWS's ES256 takes (RFC 7518, section 3.4).
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    text.encode(signed),
  );
  return `vapid t=${signed}.${b64u(new Uint8Array(sig))}, k=${vapid.publicKey}`;
}

/** The request for one push, with the headers `web-push` sent: TTL, Urgency, no Topic. */
export async function generateRequestDetails(
  subscription: Subscription,
  payload: string,
  options: WebPushOptions,
): Promise<WebPushRequest> {
  const headers: Record<string, string> = { TTL: String(options.TTL) };
  let body: Uint8Array<ArrayBuffer> | null = null;
  if (payload) {
    const p256dh = unb64u(subscription.keys.p256dh, "the subscription's p256dh");
    const auth = unb64u(subscription.keys.auth, "the subscription's auth");
    body = await encrypt(text.encode(payload), p256dh, auth);
    headers["Content-Length"] = String(body.length);
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Encoding"] = "aes128gcm";
  } else {
    headers["Content-Length"] = "0";
  }
  if (options.vapidDetails) {
    const { origin } = new URL(subscription.endpoint);
    headers.Authorization = await vapidAuthorization(origin, options.vapidDetails);
  }
  headers.Urgency = options.urgency;
  return { method: "POST", headers, body, endpoint: subscription.endpoint };
}
