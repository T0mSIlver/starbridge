import { expect, test } from "bun:test";
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import * as ece from "http_ece";
import { encrypt, generateRequestDetails, p256Jwk, vapidAuthorization } from "../src/webpush";

const b = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

// RFC 8291, Appendix A.
const rfc = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("RFC 8291's example message, byte for byte", async () => {
  const out = await encrypt(b(rfc.plaintext), b(rfc.uaPublic), b(rfc.auth), {
    salt: b(rfc.salt),
    publicKey: b(rfc.asPublic),
    privateKey: b(rfc.asPrivate),
  });
  expect(Buffer.from(out).toString("base64url")).toBe(rfc.message);
});

/** A browser's keys, held by Node's ECDH as http_ece takes them. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, p256dh: ecdh.getPublicKey(), auth: randomBytes(16) };
}

/** Node drops a private scalar's leading zero bytes; a JWK `d` keeps all 32. */
function scalar(ecdh: ReturnType<typeof createECDH>) {
  const k = ecdh.getPrivateKey();
  return Buffer.concat([Buffer.alloc(32 - k.length), k]);
}

/** Plaintext sizes from empty to the largest one record holds. */
const sizes = [0, 1, 15, 16, 17, 100, 1000, 3072, 3993, 4000, 4078, 4079];

test("http_ece decrypts what we encrypt, at every size", async () => {
  for (const size of sizes) {
    const ua = browser();
    const plain = randomBytes(size);
    const out = await encrypt(plain, new Uint8Array(ua.p256dh), new Uint8Array(ua.auth));
    const back = ece.decrypt(Buffer.from(out), {
      version: "aes128gcm",
      privateKey: ua.ecdh,
      authSecret: ua.auth.toString("base64url"),
    });
    expect(back.equals(plain)).toBe(true);
  }
  await expect(encrypt(randomBytes(4080), browser().p256dh, randomBytes(16))).rejects.toThrow(
    "one record",
  );
});

/** RFC 8291's decryption, written apart from `encrypt`, for what http_ece encrypts. */
async function decrypt(
  message: Uint8Array<ArrayBuffer>,
  uaPrivate: Uint8Array,
  uaPublic: Uint8Array,
  auth: Uint8Array<ArrayBuffer>,
) {
  const salt = message.slice(0, 16);
  const idlen = message[20] ?? 0;
  const asPublic = message.slice(21, 21 + idlen);
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const priv = await crypto.subtle.importKey("jwk", p256Jwk(uaPublic, uaPrivate), ecdh, false, [
    "deriveBits",
  ]);
  const pub = await crypto.subtle.importKey("raw", asPublic, ecdh, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hkdf = async (
    s: Uint8Array<ArrayBuffer>,
    ikm: ArrayBuffer,
    info: Uint8Array<ArrayBuffer>,
    n: number,
  ) =>
    crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: s, info },
      await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
      n * 8,
    );
  const t = new TextEncoder();
  const info = new Uint8Array(Buffer.concat([t.encode("WebPush: info\0"), uaPublic, asPublic]));
  const ikm = await hkdf(auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, t.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, t.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, message.slice(21 + idlen)),
  );
  const end = padded.lastIndexOf(2);
  expect(padded.slice(end + 1).every((x) => x === 0)).toBe(true);
  return padded.slice(0, end);
}

test("RFC 8291's decryption reads what http_ece encrypts, at every size", async () => {
  expect(
    Buffer.from(await decrypt(b(rfc.message), b(rfc.uaPrivate), b(rfc.uaPublic), b(rfc.auth))),
  ).toEqual(Buffer.from(b(rfc.plaintext)));
  for (const size of sizes) {
    const ua = browser();
    const sender = createECDH("prime256v1");
    sender.generateKeys();
    const plain = randomBytes(size);
    const out = ece.encrypt(plain, {
      version: "aes128gcm",
      dh: ua.p256dh.toString("base64url"),
      privateKey: sender,
      salt: randomBytes(16).toString("base64url"),
      authSecret: ua.auth.toString("base64url"),
    });
    const back = await decrypt(new Uint8Array(out), scalar(ua.ecdh), ua.p256dh, ua.auth);
    expect(Buffer.from(back).equals(plain)).toBe(true);
  }
});

async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey));
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: publicKey.toString("base64url"), privateKey: d as string };
}

test("the VAPID JWT verifies with Node's ES256 and carries RFC 8292's claims", async () => {
  const keys = await vapidKeys();
  const now = Date.UTC(2026, 9, 19);
  const header = await vapidAuthorization(
    "https://updates.push.services.mozilla.com",
    { ...keys, subject: "mailto:owner@example.com" },
    now,
  );
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  if (!m) throw new Error(header);
  const [, head, claims, sig, k] = m as unknown as string[];
  expect(k).toBe(keys.publicKey);
  expect(JSON.parse(Buffer.from(head as string, "base64url").toString())).toEqual({
    typ: "JWT",
    alg: "ES256",
  });
  expect(JSON.parse(Buffer.from(claims as string, "base64url").toString())).toEqual({
    aud: "https://updates.push.services.mozilla.com",
    exp: now / 1000 + 12 * 3600,
    sub: "mailto:owner@example.com",
  });
  const pub = createPublicKey({ key: p256Jwk(b(keys.publicKey)) as never, format: "jwk" });
  const data = Buffer.from(`${head}.${claims}`);
  const signature = Buffer.from(sig as string, "base64url");
  expect(verify("sha256", data, { key: pub, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  const other = Buffer.from(`${head}.${claims}x`);
  expect(verify("sha256", other, { key: pub, dsaEncoding: "ieee-p1363" }, signature)).toBe(false);
});

test("a push request has web-push's headers", async () => {
  const keys = await vapidKeys();
  const ua = browser();
  const req = await generateRequestDetails(
    {
      endpoint: "https://push.example:8443/x/y",
      keys: { p256dh: ua.p256dh.toString("base64url"), auth: ua.auth.toString("base64url") },
    },
    "hello",
    { TTL: 86_400, urgency: "high", vapidDetails: { ...keys, subject: "https://example.com" } },
  );
  expect(Object.keys(req.headers)).toEqual([
    "TTL",
    "Content-Length",
    "Content-Type",
    "Content-Encoding",
    "Authorization",
    "Urgency",
  ]);
  expect(req.headers).toMatchObject({
    TTL: "86400",
    "Content-Length": String(req.body?.length),
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    Urgency: "high",
  });
  const claims = (req.headers.Authorization as string).split(".")[1] as string;
  expect(JSON.parse(Buffer.from(claims, "base64url").toString()).aud).toBe(
    "https://push.example:8443",
  );
  const noVapid = await generateRequestDetails(
    { endpoint: "https://push.example/x", keys: { p256dh: "BAD!", auth: "x" } },
    "",
    { TTL: 60, urgency: "normal" },
  );
  expect(noVapid).toEqual({
    method: "POST",
    headers: { TTL: "60", "Content-Length": "0", Urgency: "normal" },
    body: null,
    endpoint: "https://push.example/x",
  });
  await expect(
    vapidAuthorization("https://push.example", { ...keys, subject: "http://example.com" }),
  ).rejects.toThrow("https: or mailto:");
});
