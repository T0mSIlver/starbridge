// A device detects a machine revocation the server withholds from it (#362), from the head
// another machine signs into its items.
import { beforeAll, expect, test } from "bun:test";
import {
  addEntry,
  type Directory,
  forgetHeads,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  type Heads,
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

function decisionBy(machine: "m" | "m2", dir?: { length: number; head: string; by?: string }) {
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
    decisionBy("m2", head(verifyDirectory(truth))),
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

test("a head its signer signed before a revoke keeps counting, and says who revoked it", () => {
  const full = verifyDirectory(truth);
  const forged = { length: full.length + 5, head: "A".repeat(43) };
  const heads: Heads = { m: forged };
  expect(withheldBy(heads, full, truth)).toEqual({
    id: "m",
    head: forged,
    revoked: { id: "m", by: "b", at },
  });
  expect(withheldBy(heads, verifyDirectory(seenByA), seenByA)?.revoked).toBeUndefined();
  // A head without a revocation is named first.
  heads.m2 = { length: full.length + 1, head: "B".repeat(43) };
  expect(withheldBy(heads, full, truth)?.id).toBe("m2");
  // The owner's word ends it.
  expect(forgetHeads(heads, "m")).toBe(true);
  expect(Object.keys(heads)).toEqual(["m2"]);
});

test("a revoked device cannot lift a device's hold by revoking, on a fork, the machine that exposed it (#813)", () => {
  // The owner revoked B. The server hides that from A, holds B's keys, and M2, which has seen
  // the revocation, signs its head: A holds.
  const mine = verifyDirectory(seenByA);
  const real = [
    ...seenByA,
    revokeEntry(mine, { id: "a", signKey: keys.a.sign.privateKey }, "b", at),
  ];
  const heads: Heads = {};
  noteHead(heads, "m2", head(verifyDirectory(real)), seenByA);
  expect(withheldBy(heads, mine, seenByA)).toEqual({ id: "m2", head: head(verifyDirectory(real)) });
  // With B's keys, the server extends A's stale chain with B's revocation of M2. It verifies and
  // extends A's pin, but no machine signs a head past its own revocation: it is a fork.
  const fork = [
    ...seenByA,
    revokeEntry(mine, { id: "b", signKey: keys.b.sign.privateKey }, "m2", at),
  ];
  const forked = verifyDirectory(fork, { pin: head(mine) });
  expect(withheldBy(heads, forked, fork)).toMatchObject({
    id: "m2",
    revoked: { id: "m2", by: "b" },
  });
});

test("a head a machine before #794 passed on, naming a by, is not kept", () => {
  const mine = verifyDirectory(seenByA);
  const passedOn = { ...head(verifyDirectory(truth)), by: "b" };
  // The machine's own head shows a gap; a replayed older item with a longer passed-on head, which
  // may lie on b's fork, must not push it out (#1627).
  const own = { length: mine.length, head: "B".repeat(43) };
  const heads: Heads = { m2: own };
  const opened = open(decisionBy("m2", passedOn), { id: "a", box: keys.a.box }, mine);
  expect(noteHead(heads, "m2", opened.body.dir, seenByA)).toBe(false);
  expect(heads).toEqual({ m2: own });
  // Heads kept before #1627 under "signer/by" or "signer/?" count as their signer's, and go with it.
  const kept: Heads = { "m2/b": passedOn, "m2/?": { ...passedOn, by: "ghost" } } as Heads;
  expect(withheldBy(kept, mine, seenByA)).toEqual({ id: "m2", head: head(verifyDirectory(truth)) });
  expect(forgetHeads(kept, "b")).toBe(false);
  expect(forgetHeads(kept, "m2")).toBe(true);
  expect(kept).toEqual({});
});
