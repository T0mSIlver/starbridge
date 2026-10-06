// A head relayed from a device the stale device's chain does not list still counts (#362, Fable review).
import { beforeAll, expect, test } from "bun:test";
import {
  addEntry,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  type Heads,
  headToSign,
  type Member,
  type MemberKeys,
  noteHead,
  publicKeys,
  ready,
  recoveryKeyPair,
  revokeEntry,
  verifyDirectory,
  withheldBy,
} from "../src/index";

const at = "2026-10-06T12:00:00Z";
const k: Record<string, MemberKeys> = {};
const m = (id: string, role: Member["role"]): Member => {
  k[id] = generateMemberKeys();
  return { id, role, name: id, ...publicKeys(k[id]) };
};
const by = (id: string) => ({ id, signKey: (k[id] as MemberKeys).sign.privateKey });

beforeAll(() => ready);

test("a withheld revocation made by a device the stale device never saw added is detected", () => {
  const b = m("phoneB", "device");
  const mm = m("machineM", "machine");
  const m2 = m("machineM2", "machine");
  const c = m("newPhoneC", "device");
  const chain = [
    genesisEntry({
      account: "acct",
      device: b,
      signKey: (k.phoneB as MemberKeys).sign.privateKey,
      recovery: recoveryKeyPair(generateRecoverySeed()),
      at,
    }),
  ];
  chain.push(addEntry(verifyDirectory(chain), by("phoneB"), mm, at));
  chain.push(addEntry(verifyDirectory(chain), by("phoneB"), m2, at));
  // The server stops serving B and M2 here (length 3). The owner adds phone C, which revokes M.
  const stale = chain.slice();
  const truth = [...chain];
  truth.push(addEntry(verifyDirectory(truth), by("phoneB"), c, at));
  truth.push(revokeEntry(verifyDirectory(truth), by("newPhoneC"), "machineM", at));
  const full = verifyDirectory(truth);
  const staleDir = verifyDirectory(stale);

  // M2 was served the add of C (length 4) but not the revocation; B was served neither.
  const m2Chain = truth.slice(0, 4);
  const m2Dir = verifyDirectory(m2Chain);
  // C answers M2 with its head (5); M2 keeps it and relays it with by: C, not its own head (4).
  const m2Heads: Heads = { newPhoneC: { length: full.length, head: full.head } };
  const relayed = headToSign(m2Heads, m2Dir, m2Chain);
  expect(relayed).toEqual({ length: 5, head: full.head, by: "newPhoneC" });

  // B keeps it in M2's slot for members it does not know, and holds: C's add may be what the
  // server keeps from it.
  const bHeads: Heads = {};
  noteHead(bHeads, "machineM2", relayed, stale, staleDir);
  expect(withheldBy(bHeads, staleDir, stale)).toMatchObject({ id: "machineM2", by: "newPhoneC" });
  // Served the full chain, B holds the head and M is revoked.
  expect(withheldBy(bHeads, full, truth)).toBeUndefined();
  expect(full.members.get("machineM")?.active).toBe(false);
});
