// A device detects a machine revocation the server withholds from it (#362), from the head
// another machine signs into its items.
import { beforeAll, expect, test } from "bun:test";
import {
  addEntry,
  type Directory,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  type Heads,
  headToSign,
  type Member,
  type MemberKeys,
  noteHead,
  open,
  publicKeys,
  ready,
  recoveryKeyPair,
  revokeEntry,
  type SignedEnvelope,
  seal,
  verifyDirectory,
  withheldBy,
} from "../src/index";

const at = "2026-10-06T12:00:00Z";
let keys: Record<"a" | "b" | "m" | "m2", MemberKeys>;
let members: Record<"a" | "b" | "m" | "m2", Member>;
/** Genesis A, add B, add M and M2 (machines), then B revokes M. */
let truth: SignedEnvelope[];
/** What the server serves device A: everything but the revocation. */
let seenByA: SignedEnvelope[];

beforeAll(async () => {
  await ready;
  keys = {
    a: generateMemberKeys(),
    b: generateMemberKeys(),
    m: generateMemberKeys(),
    m2: generateMemberKeys(),
  };
  const role = (k: string) => (k.startsWith("m") ? "machine" : "device") as Member["role"];
  members = Object.fromEntries(
    Object.entries(keys).map(([k, v]) => [k, { id: k, role: role(k), name: k, ...publicKeys(v) }]),
  ) as typeof members;
  const by = (k: "a" | "b") => ({ id: k, signKey: keys[k].sign.privateKey });
  const chain = [
    genesisEntry({
      account: "acct",
      device: members.a,
      signKey: keys.a.sign.privateKey,
      recovery: recoveryKeyPair(generateRecoverySeed()),
      at,
    }),
  ];
  for (const k of ["b", "m", "m2"] as const)
    chain.push(addEntry(verifyDirectory(chain), by("a"), members[k], at));
  seenByA = chain;
  truth = [...chain, revokeEntry(verifyDirectory(chain), by("b"), "m", at)];
});

const head = (d: Directory) => ({ length: d.length, head: d.head });

function decisionBy(machine: "m" | "m2", dir?: { length: number; head: string }) {
  return seal(
    "decision",
    {
      v: 1,
      id: `d_${machine}`,
      to: ["a"],
      createdAt: at,
      question: "Deploy?",
      context: "",
      options: ["Yes", "No"],
      recommended: "Yes",
      source: { machine, project: "p", session: "s" },
      ...(dir ? { dir } : {}),
    },
    { id: machine, signKey: keys[machine].sign.privateKey },
    [members.a],
  );
}

test("a machine that holds the revocation exposes it to a device the server withholds it from", () => {
  const mine = verifyDirectory(seenByA);
  // The revoked machine's item opens on A's short chain, as before.
  expect(open(decisionBy("m", head(mine)), { id: "a", box: keys.a.box }, mine).signer.id).toBe("m");
  const heads: Heads = {};
  // M2 reads the full chain and signs its head; the signed body keeps it.
  const opened = open(
    decisionBy("m2", headToSign({}, verifyDirectory(truth), truth)),
    { id: "a", box: keys.a.box },
    mine,
  );
  expect(opened.body.dir).toEqual(head(verifyDirectory(truth)));
  expect(noteHead(heads, "m2", opened.body.dir, seenByA)).toBe(true);
  expect(withheldBy(heads, mine, seenByA)).toEqual({
    id: "m2",
    head: head(verifyDirectory(truth)),
  });
  // An older M2 item with a shorter head, replayed, does not lift the hold.
  expect(noteHead(heads, "m2", head(mine), seenByA)).toBe(false);
  expect(withheldBy(heads, mine, seenByA)?.id).toBe("m2");
  // Served the revocation, A holds the head, and M's items fail as a revoked signer's.
  const full = verifyDirectory(truth);
  expect(withheldBy(heads, full, truth)).toBeUndefined();
  expect(() => open(decisionBy("m"), { id: "a", box: keys.a.box }, full)).toThrow("revoked-signer");
});

test("a head counts only while the member that signed it is active", () => {
  const full = verifyDirectory(truth);
  const heads: Heads = { m: { length: full.length + 5, head: "A".repeat(43) } };
  expect(withheldBy(heads, full, truth)).toBeUndefined();
  expect(withheldBy(heads, verifyDirectory(seenByA), seenByA)?.id).toBe("m");
});

test("a machine signs the longest head it knows, a device's when its own chain is behind", () => {
  const mine = verifyDirectory(seenByA);
  const deviceHead = head(verifyDirectory(truth));
  expect(headToSign({}, mine, seenByA)).toEqual(head(mine));
  expect(headToSign({ b: deviceHead }, mine, seenByA)).toEqual(deviceHead);
  // Not a fork's head of the same length, and not a head its chain holds.
  expect(headToSign({ b: { ...head(mine), head: "A".repeat(43) } }, mine, seenByA)).toEqual(
    head(mine),
  );
  expect(headToSign({ b: deviceHead }, verifyDirectory(truth), truth)).toEqual(deviceHead);
});
