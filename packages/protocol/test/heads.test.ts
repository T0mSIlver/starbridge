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
  expect(headToSign({ b: deviceHead }, mine, seenByA)).toEqual({ ...deviceHead, by: "b" });
  // Not a head a member its chain revoked signed.
  const inflated = { length: 99, head: "A".repeat(43) };
  expect(headToSign({ m: inflated }, verifyDirectory(truth), truth)).toEqual(deviceHead);
  // Not a fork's head of the same length, and not a head its chain holds.
  expect(headToSign({ b: { ...head(mine), head: "A".repeat(43) } }, mine, seenByA)).toEqual(
    head(mine),
  );
  expect(headToSign({ b: deviceHead }, verifyDirectory(truth), truth)).toEqual(deviceHead);
});

test("a forged head a machine passed on ends with its forger's revocation", () => {
  // Device B, compromised, signs an inflated head into an answer; honest M2 passes it on.
  const mine = verifyDirectory(seenByA);
  const forged = { length: 99, head: "A".repeat(43) };
  const relayed = headToSign({ b: forged }, mine, seenByA);
  expect(relayed).toEqual({ ...forged, by: "b" });
  const heads: Heads = {};
  noteHead(heads, "m2", relayed, seenByA);
  expect(withheldBy(heads, mine, seenByA)).toMatchObject({ id: "m2", by: "b" });
  // The owner revokes B: the head it vouched for counts no more, and M2's own head holds.
  const chain = [
    ...seenByA,
    revokeEntry(mine, { id: "a", signKey: keys.a.sign.privateKey }, "b", at),
  ];
  const after = verifyDirectory(chain);
  expect(withheldBy(heads, after, chain)).toBeUndefined();
  noteHead(heads, "m2", head(after), chain);
  expect(withheldBy(heads, after, chain)).toBeUndefined();
});

test("a head passed on from a device the chain does not list yet counts, in one slot per machine", () => {
  // The server stops serving A at M2's add; the owner adds phone C, which revokes M. M2 is served
  // C's add, not the revocation, and passes on the head C signed into an answer.
  const chain = seenByA;
  const c = { id: "c", role: "device" as const, name: "c", ...publicKeys(generateMemberKeys()) };
  const withC = [
    ...chain,
    addEntry(verifyDirectory(chain), { id: "a", signKey: keys.a.sign.privateKey }, c, at),
  ];
  const truthC = [
    ...withC,
    revokeEntry(verifyDirectory(withC), { id: "b", signKey: keys.b.sign.privateKey }, "m", at),
  ];
  const relayed = headToSign({ c: head(verifyDirectory(truthC)) }, verifyDirectory(withC), withC);
  expect(relayed.by).toBe("c");
  const mine = verifyDirectory(chain);
  const heads: Heads = {};
  noteHead(heads, "m2", relayed, chain, mine);
  expect(Object.keys(heads)).toEqual(["m2/?"]);
  expect(withheldBy(heads, mine, chain)).toMatchObject({ id: "m2", by: "c" });
  // Another unknown id takes the same slot, so a machine cannot fill storage with invented ones.
  noteHead(heads, "m2", { length: 99, head: "A".repeat(43), by: "nobody" }, chain, mine);
  expect(Object.keys(heads)).toEqual(["m2/?"]);
  // Once the chain lists the forger as revoked, its head counts no more.
  const forger = [
    ...chain,
    addEntry(mine, { id: "a", signKey: keys.a.sign.privateKey }, { ...c, id: "nobody" }, at),
  ];
  const revoked = [
    ...forger,
    revokeEntry(
      verifyDirectory(forger),
      { id: "a", signKey: keys.a.sign.privateKey },
      "nobody",
      at,
    ),
  ];
  expect(withheldBy(heads, verifyDirectory(revoked), revoked)).toBeUndefined();
  // And C's real head, passed on again, takes the slot back: the hold stands.
  noteHead(heads, "m2", relayed, revoked, verifyDirectory(revoked));
  expect(withheldBy(heads, verifyDirectory(revoked), revoked)).toMatchObject({ id: "m2", by: "c" });
});
