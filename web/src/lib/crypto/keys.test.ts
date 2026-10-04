// The browser's key paths against packages/protocol's vectors: WebCrypto keys must sign what
// libsodium signs and open what libsodium seals, with the same errors on every bad case.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  fromB64,
  open,
  openAsync,
  ProtocolError,
  ready,
  type SealedItem,
  sign,
  signAsync,
  verifyDirectory,
} from "@starbridge/protocol";
import sodium from "libsodium-wrappers";
import directoryVectors from "../../../../packages/protocol/vectors/directory.json";
import envelopeVectors from "../../../../packages/protocol/vectors/envelopes.json";
import keyVectors from "../../../../packages/protocol/vectors/keys.json";
import { generateDeviceKeys, type StoredKeys, sealOpener, signer } from "./keys";

beforeAll(async () => {
  await ready;
  await sodium.ready;
});

type VectorMember = (typeof keyVectors.members)[number];
const member = (id: string) => keyVectors.members.find((m) => m.id === id) as VectorMember;

// PKCS#8 wrappers for a raw 32-byte private key (RFC 8410).
const PKCS8 = {
  X25519: "302e020100300506032b656e04220420",
  Ed25519: "302e020100300506032b657004220420",
};
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

async function importPrivate(alg: "X25519" | "Ed25519", raw: Uint8Array): Promise<CryptoKey> {
  const der = new Uint8Array([...hex(PKCS8[alg]), ...raw]);
  const usages: KeyUsage[] = alg === "X25519" ? ["deriveBits"] : ["sign"];
  return crypto.subtle.importKey("pkcs8", der, { name: alg }, false, usages);
}

/** A vector member's keys as non-extractable WebCrypto keys. */
async function webCrypto(m: VectorMember): Promise<StoredKeys> {
  return {
    kind: "webcrypto",
    box: await importPrivate("X25519", fromB64(m.boxSk)),
    sign: await importPrivate("Ed25519", fromB64(m.signSeed)),
  };
}

const raw = (m: VectorMember): StoredKeys => ({
  kind: "raw",
  boxSk: fromB64(m.boxSk),
  signSk: fromB64(m.signSk),
});

async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (e) {
    if (e instanceof ProtocolError) return e.code;
    throw e;
  }
}

const body = {
  v: 1 as const,
  id: "a1",
  decisionId: "d1",
  to: "devbox",
  answeredAt: "2026-10-04T12:00:00Z",
  choice: "Merge",
};

for (const [name, keysOf] of [
  ["webcrypto", webCrypto],
  ["raw", async (m: VectorMember) => raw(m)],
] as const) {
  describe(`${name} keys`, () => {
    test("sign as libsodium signs", async () => {
      const phone = member("phone");
      const env = await signAsync("answer", body, "phone", signer(await keysOf(phone)));
      expect(env).toEqual(sign("answer", body, "phone", fromB64(phone.signSk)));
    });

    for (const c of envelopeVectors.sealed) {
      test(`open: ${c.name}`, async () => {
        const m = member(c.recipient);
        const dir = verifyDirectory(directoryVectors.cases[0]?.entries ?? []);
        const me = { id: m.id, openSeal: sealOpener(await keysOf(m), fromB64(m.boxPk)) };
        const run = () => openAsync(c.item as SealedItem, me, dir);
        if ("error" in c.expect) {
          expect(await errorCode(run)).toBe(c.expect.error as string);
          return;
        }
        const sync = open(
          c.item as SealedItem,
          { id: m.id, box: { publicKey: fromB64(m.boxPk), privateKey: fromB64(m.boxSk) } },
          dir,
        );
        expect(await run()).toEqual(sync);
      });
    }
  });
}

test("fresh keys open what libsodium seals to them, and refuse a tampered box", async () => {
  const keys = await generateDeviceKeys();
  expect(keys.stored.kind).toBe("webcrypto");
  const openSeal = sealOpener(keys.stored, keys.boxPk);
  for (const size of [0, 1, 100, 5000]) {
    const plain = sodium.randombytes_buf(size);
    const box = sodium.crypto_box_seal(plain, keys.boxPk);
    expect(await openSeal(box)).toEqual(plain);
    box[box.length - 1] = (box[box.length - 1] as number) ^ 1;
    await expect(openSeal(box)).rejects.toThrow();
  }
  await expect(openSeal(new Uint8Array(10))).rejects.toThrow();
  const msg = sodium.randombytes_buf(64);
  const sig = await signer(keys.stored)(msg);
  expect(sodium.crypto_sign_verify_detached(sig, msg, keys.signPk)).toBe(true);
});
