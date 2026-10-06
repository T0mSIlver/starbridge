// The whole trust flow with fresh random keys, as server, CLI and clients will run it.
import { beforeAll, expect, test } from "bun:test";
import {
  activeMembers,
  addEntry,
  checkJoined,
  formatPairingCode,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  holdsHead,
  type Member,
  type MemberKeys,
  newPairingCode,
  open,
  openPairingApproval,
  openPairingRequest,
  type ProtocolError,
  pairingApproval,
  pairingRequest,
  parsePairingCode,
  publicKeys,
  RECOVERY,
  ready,
  recoverEntry,
  recoveryKey,
  recoveryKeyPair,
  recoverySeedFromKey,
  type SignedEnvelope,
  seal,
  toB64,
  verifyDirectory,
} from "../src/index";

const at = "2026-10-04T12:00:00Z";
const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as ProtocolError).code;
  }
};

let phoneKeys: MemberKeys;
let phone: Member;
let chain: SignedEnvelope[];
let recoveryText: string;

beforeAll(async () => {
  await ready;
  phoneKeys = generateMemberKeys();
  phone = { id: "phone", role: "device", name: "Pixel", ...publicKeys(phoneKeys) };
  const seed = generateRecoverySeed();
  recoveryText = recoveryKey(seed);
  chain = [
    genesisEntry({
      account: "acct",
      device: phone,
      signKey: phoneKeys.sign.privateKey,
      recovery: recoveryKeyPair(seed),
      at,
    }),
  ];
});

test("pair a machine, ask, answer", () => {
  // The CLI makes keys and a code, and posts the request.
  const machineKeys = generateMemberKeys();
  const shown = newPairingCode();
  const request = pairingRequest(
    {
      v: 1,
      rendezvous: shown.rendezvous,
      role: "machine",
      id: "devbox",
      name: "dev box",
      ...publicKeys(machineKeys),
      at,
    },
    shown,
  );

  // The owner types the code on the phone, which checks the request and signs the entry.
  const typed = parsePairingCode(formatPairingCode(shown).toLowerCase());
  const req = openPairingRequest(request, typed);
  const before = verifyDirectory(chain);
  chain.push(
    addEntry(
      before,
      { id: phone.id, signKey: phoneKeys.sign.privateKey },
      { id: req.id, role: req.role, name: req.name, boxPk: req.boxPk, signPk: req.signPk },
      at,
    ),
  );
  const after = verifyDirectory(chain);
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: typed.rendezvous,
      account: after.account,
      length: after.length,
      head: after.head,
      approver: phone.id,
    },
    typed,
  );

  // The CLI checks the approval, then pins the directory it was approved into.
  const ok = openPairingApproval(approval, shown);
  const pin = { length: ok.length, head: ok.head };
  const machineView = verifyDirectory(chain, { account: ok.account, pin });
  checkJoined(machineView, { id: "devbox", role: "machine", ...publicKeys(machineKeys) });

  // A decision sealed to every active device, and its answer sealed back.
  const devices = activeMembers(machineView, "device");
  const decision = seal(
    "decision",
    {
      v: 1,
      id: "d1",
      to: devices.map((d) => d.id),
      createdAt: at,
      question: "Merge?",
      context: "",
      options: ["Yes", "No"],
      recommended: "Yes",
      source: { machine: "dev box", project: "starbridge", session: "s1" },
    },
    { id: "devbox", signKey: machineKeys.sign.privateKey },
    devices,
  );
  const phoneView = verifyDirectory(chain);
  const read = open(decision, { id: "phone", box: phoneKeys.box }, phoneView);
  expect(read.body.question).toBe("Merge?");

  const answer = seal(
    "answer",
    { v: 1, id: "a1", decisionId: read.body.id, to: "devbox", answeredAt: at, choice: "Yes" },
    { id: "phone", signKey: phoneKeys.sign.privateKey },
    [machineView.members.get("devbox")?.member as Member],
  );
  expect(open(answer, { id: "devbox", box: machineKeys.box }, machineView).body.choice).toBe("Yes");
});

test("a server that answers the pairing itself is caught", () => {
  const machineKeys = generateMemberKeys();
  const shown = newPairingCode();
  // The server knows the rendezvous id but not the secret, so it guesses a key.
  const forged = pairingApproval(
    { v: 1, rendezvous: shown.rendezvous, account: "acct", length: 1, head: "AAAA", approver: "x" },
    { rendezvous: shown.rendezvous, secret: newPairingCode().secret },
  );
  expect(code(() => openPairingApproval(forged, shown))).toBe("bad-mac");
  // Nor can it swap the machine's keys in the request.
  const request = pairingRequest(
    {
      v: 1,
      rendezvous: shown.rendezvous,
      role: "machine",
      id: "m2",
      name: "m2",
      ...publicKeys(machineKeys),
      at,
    },
    shown,
  );
  const swapped = {
    ...request,
    body: request.body.replace(
      publicKeys(machineKeys).boxPk,
      publicKeys(generateMemberKeys()).boxPk,
    ),
  };
  expect(code(() => openPairingRequest(swapped, shown))).toBe("bad-mac");
});

test("recover with the key after losing every device", () => {
  const seed = recoverySeedFromKey(recoveryText.toLowerCase().replace(/-/g, " "));
  const recovery = recoveryKeyPair(seed);
  const dir = verifyDirectory(chain, { recoveryPk: toB64(recovery.publicKey) });
  const replacement: Member = {
    id: "phone3",
    role: "device",
    name: "Replacement",
    ...publicKeys(generateMemberKeys()),
  };
  const recovered = [...chain, recoverEntry(dir, recovery.privateKey, replacement, at)];
  expect(verifyDirectory(recovered).members.get("phone3")?.active).toBe(true);
  // A plain add signed by the recovery key is refused: recovery is `recover`.
  const added = [
    ...chain,
    addEntry(dir, { id: RECOVERY, signKey: recovery.privateKey }, replacement, at),
  ];
  expect(code(() => verifyDirectory(added))).toBe("signer-not-allowed");
});

test("a chain holds the heads of its prefixes only", () => {
  const dir = verifyDirectory(chain);
  const head = { length: dir.length, head: dir.head };
  expect(holdsHead(chain, head)).toBe(true);
  expect(holdsHead(chain, { length: 1, head: verifyDirectory(chain.slice(0, 1)).head })).toBe(true);
  expect(holdsHead(chain, { ...head, length: dir.length + 1 })).toBe(false);
  expect(holdsHead(chain.slice(0, 1), head)).toBe(dir.length === 1);
  expect(holdsHead(chain, { ...head, head: "A".repeat(43) })).toBe(false);
});
