import { expect, test } from "bun:test";
import {
  addEntry,
  type Directory,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  publicKeys,
  RECOVERY,
  recoverEntry,
  recoveryConfirmEntry,
  recoveryEntry,
  recoveryKeyPair,
  revokeEntry,
  type SignedEnvelope,
  sign,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import {
  append,
  at,
  directory,
  makeServer,
  pair,
  revoke,
  setupAccount,
  signIn,
} from "../test-support/app";

const memberOf = (id: string, role: "device" | "machine" = "device") => {
  const keys = generateMemberKeys();
  return { keys, member: { id, role, name: id, ...publicKeys(keys) } };
};

test("the genesis entry binds the session to its device and the chain is served back", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const me = await s.call("GET", "/v1/me", { token: acct.device.token });
  expect(me.json).toEqual({ account: acct.id, member: "phone", role: "device" });
  const r = await s.call("GET", "/v1/directory", { token: acct.device.token });
  expect(verifyDirectory(r.json.entries, { account: acct.id }).length).toBe(1);
  expect(
    (await s.call("GET", "/v1/directory?from=1", { token: acct.device.token })).json.entries,
  ).toEqual([]);
});

test("reading the directory needs a sign-in", async () => {
  const s = await makeServer();
  expect((await s.call("GET", "/v1/directory")).status).toBe(401);
});

test("a genesis for another account is refused", async () => {
  const s = await makeServer();
  const token = await signIn(s);
  const { keys, member } = memberOf("phone");
  const entry = genesisEntry({
    account: "someone-else",
    device: member,
    signKey: keys.sign.privateKey,
    recovery: recoveryKeyPair(generateRecoverySeed()),
    at,
  });
  const r = await append(s, token, entry);
  expect(r.status).toBe(400);
  expect(r.json.error).toBe("wrong-account");
});

test("an entry that is not the next one gets 409", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const dir = await directory(s, acct.device.token);
  const signer = { id: "phone", signKey: acct.device.keys.sign.privateKey };
  const first = addEntry(dir, signer, memberOf("laptop").member, at);
  expect((await append(s, acct.device.token, first)).status).toBe(201);
  // Built on the old head: same seq as the entry just stored.
  const stale = addEntry(dir, signer, memberOf("tablet").member, at);
  const r = await append(s, acct.device.token, stale);
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("not-next");
});

test("a forged signature is refused", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const dir = await directory(s, acct.device.token);
  const forged = addEntry(
    dir,
    { id: "phone", signKey: generateMemberKeys().sign.privateKey },
    memberOf("x").member,
    at,
  );
  const r = await append(s, acct.device.token, forged);
  expect(r.status).toBe(400);
  expect(r.json.error).toBe("bad-signature");
});

test("a session without a device can only write the genesis or a recovery entry", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const unpaired = await signIn(s);
  const dir = await directory(s, acct.device.token);
  // Signed by the phone, but posted by a session that is not the phone.
  const entry = addEntry(
    dir,
    { id: "phone", signKey: acct.device.keys.sign.privateKey },
    memberOf("x").member,
    at,
  );
  const r = await append(s, unpaired, entry);
  expect(r.status).toBe(403);
});

test("recovery adds a device and binds the recovering session to it", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const fresh = await signIn(s);
  const dir = await directory(s, fresh);
  const { member } = memberOf("new-phone");
  const entry = addEntry(dir, { id: RECOVERY, signKey: acct.recovery.privateKey }, member, at);
  expect((await append(s, fresh, entry)).status).toBe(201);
  expect((await s.call("GET", "/v1/me", { token: fresh })).json.member).toBe("new-phone");
});

test("machines cannot write the directory", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const m = await pair(s, acct, "devbox", "machine");
  const dir = await directory(s, m.token);
  const entry = addEntry(
    dir,
    { id: "devbox", signKey: m.keys.sign.privateKey },
    memberOf("x").member,
    at,
  );
  expect((await append(s, m.token, entry)).status).toBe(403);
});

test("an account holds at most maxMachines machines", async () => {
  const s = await makeServer({ maxMachines: 2 });
  const acct = await setupAccount(s);
  await pair(s, acct, "m1", "machine");
  await pair(s, acct, "m2", "machine");
  const dir = await directory(s, acct.device.token);
  const r = await append(
    s,
    acct.device.token,
    addEntry(
      dir,
      { id: "phone", signKey: acct.device.keys.sign.privateKey },
      memberOf("m3", "machine").member,
      at,
    ),
  );
  expect(r.status).toBe(403);
  expect(r.json.error).toBe("machine-cap");
  // A revoked machine frees its place.
  expect((await revoke(s, acct, "m1")).status).toBe(201);
  await pair(s, acct, "m3", "machine");
});

test("revoking a machine drops its token; revoking a device ends its sessions", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const m = await pair(s, acct, "devbox", "machine");
  const laptop = await pair(s, acct, "laptop", "device", await signIn(s));
  expect((await s.call("GET", "/v1/me", { token: m.token })).status).toBe(200);
  expect((await s.call("GET", "/v1/me", { token: laptop.token })).json.member).toBe("laptop");
  await revoke(s, acct, "devbox");
  await revoke(s, acct, "laptop");
  expect((await s.call("GET", "/v1/me", { token: m.token })).status).toBe(401);
  const me = await s.call("GET", "/v1/me", { token: laptop.token });
  expect(me.status).toBe(401);
  // The revoked device's browser learns why, so it shows the landing page, not sign-in.
  expect(me.json.error).toBe("revoked");
});

test("replacing the recovery key: the old key confirms, then signs nothing more (#348)", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const phone = { id: acct.device.id, signKey: acct.device.keys.sign.privateKey };
  const oldKey = { id: RECOVERY, signKey: acct.recovery.privateKey };
  const newRecovery = recoveryKeyPair(generateRecoverySeed());
  const token = acct.device.token;
  const step = async (make: (d: Directory) => SignedEnvelope) =>
    append(s, token, make(await directory(s, token)));

  expect((await step((d) => recoveryEntry(d, phone, newRecovery, at))).status).toBe(201);
  expect((await step((d) => recoveryConfirmEntry(d, acct.recovery.privateKey, at))).status).toBe(
    201,
  );
  expect((await directory(s, token)).recoveryPk).toBe(toB64(newRecovery.publicKey));

  const refused = await step((d) => addEntry(d, oldKey, memberOf("thief").member, at));
  expect(refused.status).toBe(400);
  expect(refused.json.error).toBe("bad-signature");
  const newKey = { id: RECOVERY, signKey: newRecovery.privateKey };
  expect((await step((d) => addEntry(d, newKey, memberOf("new-phone").member, at))).status).toBe(
    201,
  );
});

test("only the recovery key confirms a replacement, and it revokes no one (#348, #364)", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const laptop = await pair(s, acct, "laptop", "device", await signIn(s));
  const tablet = await pair(s, acct, "tablet", "device", await signIn(s));
  const as = (a: { id: string; keys: { sign: { privateKey: Uint8Array } } }) => ({
    id: a.id,
    signKey: a.keys.sign.privateKey,
  });
  const read = () => directory(s, acct.device.token);
  const proposal = recoveryEntry(
    await read(),
    as(acct.device),
    recoveryKeyPair(generateRecoverySeed()),
    at,
  );
  expect((await append(s, acct.device.token, proposal)).status).toBe(201);

  // A second device cannot stand in for the key: a stolen phone could add one (review of #368).
  const proposed = await read();
  const byDevice = sign(
    "directory",
    {
      v: 1,
      account: acct.id,
      seq: proposed.length,
      prev: proposed.head,
      at,
      op: "recovery-confirm",
      proposal: proposed.pendingRecovery?.seq as number,
    },
    laptop.id,
    laptop.keys.sign.privateKey,
  );
  const refused = await append(s, laptop.token, byDevice);
  expect(refused.json.error).toBe("signer-not-allowed");

  const byKey = { id: RECOVERY, signKey: acct.recovery.privateKey };
  const revoking = await append(
    s,
    acct.device.token,
    revokeEntry(await read(), byKey, "laptop", at),
  );
  expect(revoking.json.error).toBe("signer-not-allowed");

  await revoke(s, acct, "tablet");
  const late = recoveryEntry(await read(), as(tablet), recoveryKeyPair(generateRecoverySeed()), at);
  const r = await append(s, acct.device.token, late);
  expect(r.status).toBe(400);
  expect(r.json.error).toBe("revoked-signer");
});

test("recovery revokes every other device and ends their sessions (#363)", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const laptop = await pair(s, acct, "laptop", "device", await signIn(s));
  const fresh = await signIn(s);
  const { member } = memberOf("new-phone");
  const r = await append(
    s,
    fresh,
    recoverEntry(await directory(s, acct.device.token), acct.recovery.privateKey, member, at),
  );
  expect(r.status).toBe(201);
  expect((await s.call("GET", "/v1/me", { token: fresh })).json.member).toBe("new-phone");
  expect((await s.call("GET", "/v1/me", { token: laptop.token })).status).toBe(401);
  expect((await s.call("GET", "/v1/me", { token: acct.device.token })).status).toBe(401);
});
