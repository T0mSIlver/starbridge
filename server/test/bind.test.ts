import { expect, test } from "bun:test";
import { bindMessage, toB64 } from "@starbridge/protocol";
import {
  type Actor,
  makeServer,
  pair,
  revoke,
  type Server,
  setupAccount,
  signIn,
} from "../test-support/app";

async function challenge(s: Server, session: string): Promise<string> {
  const r = await s.call("GET", "/v1/auth/challenge", { token: session });
  expect(r.status).toBe(200);
  return r.json.nonce;
}

/** Ed25519 over the bind message with the device's key (its first 32 bytes are the seed). */
async function sign(account: string, member: string, nonce: string, d: Pick<Actor, "keys">) {
  const pkcs8 = new Uint8Array([
    ...[
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
      0x20,
    ],
    ...d.keys.sign.privateKey.subarray(0, 32),
  ]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const msg = bindMessage(account, member, nonce);
  return toB64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, msg as BufferSource)));
}

test("a new session binds to a device that signs the nonce", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const session = await signIn(s);
  expect((await s.call("GET", "/v1/me", { token: session })).json.member).toBeNull();

  const nonce = await challenge(s, session);
  const sig = await sign(acct.id, "phone", nonce, acct.device);
  const r = await s.call("POST", "/v1/auth/bind", {
    token: session,
    body: { member: "phone", sig },
  });
  expect(r.status).toBe(200);
  expect((await s.call("GET", "/v1/me", { token: session })).json.member).toBe("phone");
  // The bound session reads what a device reads.
  expect((await s.call("GET", "/v1/items", { token: session })).status).toBe(200);

  // Each nonce allows one attempt.
  const again = await s.call("POST", "/v1/auth/bind", {
    token: session,
    body: { member: "phone", sig },
  });
  expect(again.json.error).toBe("no-challenge");
});

test("binding refuses another key, another device, a revoked device and a used nonce", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const tablet = await pair(s, acct, "tablet", "device", await signIn(s));
  const bind = async (session: string, member: string, sig: (nonce: string) => Promise<string>) => {
    const nonce = await challenge(s, session);
    return s.call("POST", "/v1/auth/bind", {
      token: session,
      body: { member, sig: await sig(nonce) },
    });
  };

  const session = await signIn(s);
  // The tablet's key does not sign for the phone.
  let r = await bind(session, "phone", (n) => sign(acct.id, "phone", n, tablet));
  expect([r.status, r.json.error]).toEqual([401, "bad-signature"]);
  // A signature over another member's binding does not carry over.
  r = await bind(session, "phone", (n) => sign(acct.id, "tablet", n, acct.device));
  expect(r.json.error).toBe("bad-signature");
  // Nor one for another nonce.
  r = await bind(session, "phone", () => sign(acct.id, "phone", "other", acct.device));
  expect(r.json.error).toBe("bad-signature");
  r = await bind(session, "nobody", (n) => sign(acct.id, "nobody", n, acct.device));
  expect(r.status).toBe(404);

  expect((await revoke(s, acct, "tablet")).status).toBe(201);
  r = await bind(session, "tablet", (n) => sign(acct.id, "tablet", n, tablet));
  expect(r.status).toBe(404);

  // A session already bound stays with its device.
  r = await bind(acct.device.token, "tablet", (n) => sign(acct.id, "tablet", n, tablet));
  expect(r.json.error).toBe("already-paired");

  // Without a challenge first.
  r = await s.call("POST", "/v1/auth/bind", {
    token: session,
    body: { member: "phone", sig: "AAAA" },
  });
  expect(r.json.error).toBe("no-challenge");
  expect((await s.call("GET", "/v1/me", { token: session })).json.member).toBeNull();
});

test("machines cannot ask for a challenge", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const machine = await pair(s, acct, "devbox", "machine");
  expect((await s.call("GET", "/v1/auth/challenge", { token: machine.token })).status).toBe(403);
});
