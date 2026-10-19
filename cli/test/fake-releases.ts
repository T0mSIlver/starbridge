import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** A throwaway minisign key that signs the way `minisign -S` does (prehashed "ED"). */
export function signer(id = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    pubkey: Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64"),
    /** `change` alters the file's signature before the trusted comment's signs it. */
    sign(file: Uint8Array, comment = "starbridge test", change = (s: Buffer) => s) {
      const s = change(sign(null, createHash("blake2b512").update(file).digest(), privateKey));
      const global = sign(null, Buffer.concat([s, Buffer.from(comment)]), privateKey);
      const sig = Buffer.concat([Buffer.from("ED"), id, s]).toString("base64");
      return `untrusted comment: test\n${sig}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
    },
  };
}
