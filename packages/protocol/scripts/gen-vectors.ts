/**
 * Writes the JSON test vectors in ../vectors. Keys come from fixed seeds, so everything but the
 * sealed boxes (which use a fresh ephemeral key each run) comes out the same on every run.
 * Run: bun run vectors
 */
import {
  ANSWER_TEXT_MAX,
  addEntry,
  alertsFor,
  approverKeys,
  arrangeQuotas,
  BLOB_MAX,
  bindMessage,
  checkCode,
  checkProof,
  claimHash,
  codeFromLink,
  computePace,
  contextText,
  DEFAULT_ALERT_RULE,
  DEFAULT_QUOTA_ALERTS,
  type Directory,
  encodeCrockford,
  entryHash,
  forgetHeads,
  formatPairingCode,
  genesisEntry,
  type Heads,
  hashInput,
  ITEM_BYTES,
  joinApproval,
  joinCommitment,
  joinerKeys,
  joinRequest,
  linkChip,
  type Member,
  type MemberKeys,
  machineQrText,
  memberKeysFromSeeds,
  noteHead,
  type Pace,
  PRESENCE_BEAT_MS,
  PRESENCE_INPUT_MS,
  PUSH_HOLD_CHOICES,
  pairingApproval,
  pairingKey,
  pairingLink,
  pairingRequest,
  parseContext,
  parsePairingCode,
  publicKeys,
  QUOTA_ALERT_CHOICES,
  QUOTA_ALERT_LABELS,
  QUOTA_STATE_WORDS,
  type QuotaAlert,
  type QuotaAlertChoice,
  type QuotaAlertSettings,
  quotaCourse,
  quotaRunningOut,
  quotaState,
  RECOVERY,
  ready,
  recoverEntry,
  recoveryConfirmEntry,
  recoveryEntry,
  recoveryKey,
  recoveryKeyPair,
  revokeEntry,
  type SealedItem,
  type SignedEnvelope,
  SNOOZE_MAX_MS,
  seal,
  sign,
  signatureMessage,
  toB64,
  verifyDirectory,
  wantsQuotaAlert,
  withheldBy,
  withWindowAlerts,
} from "../src/index";
import { concat, fromB64, sodium, utf8 } from "../src/sodium";

const seed = (n: number) => new Uint8Array(32).fill(n);
/** A pairing message MAC'd as `kind` under `key` without checking its body, as a forger would. */
const macUnchecked = (kind: string, body: object, key: Uint8Array) => {
  const text = JSON.stringify(body);
  const message = concat(utf8(`starbridge/v1/${kind}`), new Uint8Array([0]), utf8(text));
  return { body: text, mac: toB64(sodium.crypto_auth(message, key)) };
};
const ACCOUNT = "acct_tom";
/** A recovery seed is 16 bytes. */
const recoverySeedOf = (n: number) => new Uint8Array(16).fill(n);
const T = (h: number, m = 0) =>
  `2026-10-04T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

interface Who {
  member: Member;
  keys: MemberKeys;
  boxSeed: number;
  signSeed: number;
}

function who(id: string, role: Member["role"], name: string, n: number): Who {
  const keys = memberKeysFromSeeds(seed(n), seed(n + 100));
  return { member: { id, role, name, ...publicKeys(keys) }, keys, boxSeed: n, signSeed: n + 100 };
}

const signer = (w: Who) => ({ id: w.member.id, signKey: w.keys.sign.privateKey });

export async function buildVectors(): Promise<Record<string, unknown>> {
  await ready;
  const phone = who("phone", "device", "Pixel", 1);
  const browser = who("browser", "device", "Firefox on the Mac", 2);
  const devbox = who("devbox", "machine", "dev box", 3);
  const phone2 = who("phone2", "device", "New Pixel", 4);
  const evil = who("evil", "device", "Injected", 5);
  const evilMachine = who("evilbox", "machine", "Injected machine", 6);
  const recoverySeed = recoverySeedOf(9);
  const recovery = recoveryKeyPair(recoverySeed);
  const recoveryPk = toB64(recovery.publicKey);

  // --- keys.json ---
  const keys = {
    note: "Member keys come from 32-byte seeds: box seed filled with n, sign seed with n+100.",
    members: [phone, browser, devbox, phone2, evil, evilMachine].map((w) => ({
      ...w.member,
      boxSeed: toB64(seed(w.boxSeed)),
      signSeed: toB64(seed(w.signSeed)),
      boxSk: toB64(w.keys.box.privateKey),
      signSk: toB64(w.keys.sign.privateKey),
    })),
    recovery: {
      note: 'A 16-byte seed as a recovery key (the seed and 12 bits of BLAKE2b-256 of "starbridge/v1/recovery-check", NUL, the seed, in Crockford base32): the signing seed is BLAKE2b-256 of "starbridge/v1/recovery-seed", NUL, the seed.',
      seed: toB64(recoverySeed),
      key: recoveryKey(recoverySeed),
      signPk: recoveryPk,
      // JavaScript's \s, which every client strips: U+00A0, U+3000 and U+FEFF are in it (#1145).
      typed: [
        recoveryKey(recoverySeed).toLowerCase(),
        recoveryKey(recoverySeed).replace(/-/g, ""),
        recoveryKey(recoverySeed).replace(/-/g, " "),
        recoveryKey(recoverySeed).replace(/0/g, "O").replace(/1/g, "l"),
        recoveryKey(recoverySeed)
          .replace("-", "\u00A0")
          .replace("-", "\u3000")
          .replace("-", "\uFEFF"),
      ],
      // While typing: the first character no key holds, and the count, in code points (#1305).
      read: [
        { typed: "144GU", count: 5, index: 4, char: "U" },
        { typed: "\u{1F600}AB", count: 3, index: 0, char: "\u{1F600}" },
        { typed: "AB-\u{1F600}C", count: 4, index: 2, char: "\u{1F600}" },
        { typed: "\u{1F44D}\u{1F3FD}1", count: 3, index: 0, char: "\u{1F44D}" },
      ],
    },
  };

  // --- directory.json ---
  const chain: SignedEnvelope[] = [
    genesisEntry({
      account: ACCOUNT,
      device: phone.member,
      signKey: phone.keys.sign.privateKey,
      recovery,
      at: T(9),
    }),
  ];
  const extend = (make: (d: Directory) => SignedEnvelope) => {
    chain.push(make(verifyDirectory(chain)));
  };
  extend((d) => addEntry(d, signer(phone), browser.member, T(9, 5)));
  extend((d) => addEntry(d, signer(phone), devbox.member, T(9, 10)));
  extend((d) => revokeEntry(d, signer(phone), "browser", T(9, 15)));
  extend((d) => addEntry(d, signer(phone), phone2.member, T(9, 20)));
  const full = verifyDirectory(chain);
  const at3 = verifyDirectory(chain.slice(0, 3));

  const tamperSig = (e: SignedEnvelope): SignedEnvelope => {
    const sig = sodium.from_base64(e.sig, sodium.base64_variants.URLSAFE_NO_PADDING);
    sig[0] = (sig[0] ?? 0) ^ 1;
    return { ...e, sig: toB64(sig) };
  };
  const otherGenesis = genesisEntry({
    account: ACCOUNT,
    device: evil.member,
    signKey: evil.keys.sign.privateKey,
    recovery: recoveryKeyPair(recoverySeedOf(8)),
    at: T(9),
  });
  const fakeChain = [otherGenesis];
  // The server's own device in a genesis naming the owner's public recovery key, with a
  // recovery signature it can only make with some other key.
  const forgedBody = JSON.parse(otherGenesis.body);
  forgedBody.recoveryPk = recoveryPk;
  const forgedEnv = sign("directory", forgedBody, "evil", evil.keys.sign.privateKey);
  const forgedGenesis: SignedEnvelope = {
    ...forgedEnv,
    recoverySig: toB64(
      sodium.crypto_sign_detached(
        signatureMessage("directory", RECOVERY, forgedEnv.body),
        evil.keys.sign.privateKey,
      ),
    ),
  };
  const fakeDir = verifyDirectory(fakeChain);
  fakeChain.push(addEntry(fakeDir, signer(evil), devbox.member, T(9, 1)));

  const signRaw = (body: object, id: string, key: Uint8Array) =>
    sign("directory", body as never, id, key);
  const nextBody = (d: Directory, extra: object) => ({
    v: 1,
    account: ACCOUNT,
    seq: d.length,
    prev: d.head,
    at: T(10),
    ...extra,
  });

  type Case = { name: string; entries: SignedEnvelope[]; options?: object; expect: object };
  const ok = (d: Directory) => ({
    ok: true,
    length: d.length,
    head: d.head,
    active: [...d.members.values()].filter((m) => m.active).map((m) => m.member.id),
    revoked: [...d.members.values()].filter((m) => !m.active).map((m) => m.member.id),
    recoveryPk: d.recoveryPk,
  });
  const pin = { length: 3, head: entryHash((chain[2] as SignedEnvelope).body) };

  // Replacing the recovery key (PROTOCOL.md, "Replacing the recovery key"), on the valid chain:
  // phone and phone2 active, browser revoked, devbox a machine.
  function recoveryCases(): Case[] {
    const next = verifyDirectory(chain);
    const newRec = recoveryKeyPair(recoverySeedOf(30));
    const newRecPk = toB64(newRec.publicKey);
    const with_ = (entries: SignedEnvelope[], make: (d: Directory) => SignedEnvelope) => [
      ...entries,
      make(verifyDirectory(entries)),
    ];
    const proposed = with_(chain, (d) => recoveryEntry(d, signer(phone), newRec, T(10)));
    const byOldKey = with_(proposed, (d) =>
      recoveryConfirmEntry(d, recovery.privateKey, newRecPk, T(10, 1)),
    );
    const replaced = verifyDirectory(byOldKey);
    const proposalBody = (d: Directory, pk: string) =>
      nextBody(d, { op: "recovery", recoveryPk: pk });
    const withSig = (env: SignedEnvelope, key: Uint8Array): SignedEnvelope => ({
      ...env,
      recoverySig: toB64(
        sodium.crypto_sign_detached(signatureMessage("directory", RECOVERY, env.body), key),
      ),
    });
    const confirmBody = (d: Directory, proposal: number, pk = newRecPk) =>
      nextBody(d, { op: "recovery-confirm", proposal, recoveryPk: pk });
    const proposedByPhone2 = with_(chain, (d) => recoveryEntry(d, signer(phone2), newRec, T(10)));
    const revokedProposer = with_(proposedByPhone2, (d) =>
      revokeEntry(d, signer(phone), "phone2", T(10, 1)),
    );
    const secondProposal = with_(proposed, (d) =>
      recoveryEntry(d, signer(phone2), recoveryKeyPair(recoverySeedOf(31)), T(10, 1)),
    );
    const recovered = with_(chain, (d) => recoverEntry(d, recovery.privateKey, evil.member, T(10)));
    // The server serves the chain cut short of browser's revocation (#363).
    const cutShort = with_(chain.slice(0, 3), (d) =>
      recoverEntry(d, recovery.privateKey, evil.member, T(10)),
    );
    const byNewKey = with_(byOldKey, (d) =>
      recoverEntry(d, newRec.privateKey, evil.member, T(10, 2)),
    );
    return [
      { name: "recovery key replaced with the old key", entries: byOldKey, expect: ok(replaced) },
      {
        name: "a pending proposal leaves the recovery key as it was",
        entries: proposed,
        expect: ok(verifyDirectory(proposed)),
      },
      {
        name: "replaced chain against the new recovery key",
        entries: byOldKey,
        options: { recoveryPk: newRecPk },
        expect: ok(replaced),
      },
      {
        name: "replaced chain against the old recovery key",
        entries: byOldKey,
        options: { recoveryPk },
        expect: { error: "wrong-recovery-key" },
      },
      {
        name: "old recovery key recovers after its replacement",
        entries: with_(byOldKey, (d) =>
          recoverEntry(d, recovery.privateKey, evil.member, T(10, 2)),
        ),
        expect: { error: "bad-signature" },
      },
      {
        name: "new recovery key recovers",
        entries: byNewKey,
        expect: ok(verifyDirectory(byNewKey)),
      },
      {
        name: "a device confirms a proposal",
        entries: [
          ...proposed,
          signRaw(
            confirmBody(verifyDirectory(proposed), next.length),
            "phone2",
            phone2.keys.sign.privateKey,
          ),
        ],
        expect: { error: "signer-not-allowed" },
      },
      {
        name: "proposing device confirms its own proposal",
        entries: [
          ...proposed,
          signRaw(
            confirmBody(verifyDirectory(proposed), next.length),
            "phone",
            phone.keys.sign.privateKey,
          ),
        ],
        expect: { error: "signer-not-allowed" },
      },
      {
        name: "revoked device proposes a recovery key",
        entries: [
          ...chain,
          withSig(
            signRaw(proposalBody(next, newRecPk), "browser", browser.keys.sign.privateKey),
            newRec.privateKey,
          ),
        ],
        expect: { error: "revoked-signer" },
      },
      {
        name: "a proposal dies with its revoked proposer",
        entries: with_(revokedProposer, (d) =>
          signRaw(confirmBody(d, next.length), RECOVERY, recovery.privateKey),
        ),
        expect: { error: "bad-recovery" },
      },
      {
        name: "a later proposal replaces a pending one",
        entries: with_(secondProposal, (d) =>
          signRaw(confirmBody(d, next.length), RECOVERY, recovery.privateKey),
        ),
        expect: { error: "bad-recovery" },
      },
      {
        name: "proposal without the new key's signature",
        entries: [
          ...chain,
          signRaw(proposalBody(next, newRecPk), "phone", phone.keys.sign.privateKey),
        ],
        expect: { error: "bad-recovery" },
      },
      {
        name: "proposal naming a key it holds no signature of",
        entries: [
          ...chain,
          withSig(
            signRaw(proposalBody(next, newRecPk), "phone", phone.keys.sign.privateKey),
            evil.keys.sign.privateKey,
          ),
        ],
        expect: { error: "bad-signature" },
      },
      {
        name: "proposal naming a member's key",
        entries: [
          ...chain,
          withSig(
            signRaw(proposalBody(next, phone2.member.signPk), "phone", phone.keys.sign.privateKey),
            phone2.keys.sign.privateKey,
          ),
        ],
        expect: { error: "bad-recovery" },
      },
      {
        name: "proposal bringing back a retired recovery key",
        entries: with_(byOldKey, (d) => recoveryEntry(d, signer(phone), recovery, T(10, 2))),
        expect: { error: "bad-recovery" },
      },
      {
        name: "recovery key proposes its successor",
        entries: [
          ...chain,
          withSig(
            signRaw(proposalBody(next, newRecPk), RECOVERY, recovery.privateKey),
            newRec.privateKey,
          ),
        ],
        expect: { error: "signer-not-allowed" },
      },
      {
        name: "machine confirms a proposal",
        entries: [
          ...proposed,
          signRaw(
            confirmBody(verifyDirectory(proposed), next.length),
            "devbox",
            devbox.keys.sign.privateKey,
          ),
        ],
        expect: { error: "signer-not-allowed" },
      },
      {
        name: "confirmation naming another key than the pending proposal",
        entries: [
          ...proposed,
          signRaw(
            confirmBody(
              verifyDirectory(proposed),
              next.length,
              toB64(recoveryKeyPair(recoverySeedOf(31)).publicKey),
            ),
            RECOVERY,
            recovery.privateKey,
          ),
        ],
        expect: { error: "bad-recovery" },
      },
      {
        name: "confirmation with no proposal",
        entries: [...chain, signRaw(confirmBody(next, 1), RECOVERY, recovery.privateKey)],
        expect: { error: "bad-recovery" },
      },
      {
        name: "recovery revokes every other member, machines too",
        entries: recovered,
        expect: ok(verifyDirectory(recovered)),
      },
      {
        name: "recovery onto a chain cut short of a revocation keeps that member revoked",
        entries: cutShort,
        expect: ok(verifyDirectory(cutShort)),
      },
      {
        name: "a device signs a recovery",
        entries: [
          ...chain,
          signRaw(
            nextBody(next, { op: "recover", member: evil.member }),
            "phone",
            phone.keys.sign.privateKey,
          ),
        ],
        expect: { error: "signer-not-allowed" },
      },
      {
        name: "recovery adds a machine",
        entries: [
          ...chain,
          signRaw(
            nextBody(next, { op: "recover", member: evilMachine.member }),
            RECOVERY,
            recovery.privateKey,
          ),
        ],
        expect: { error: "signer-not-allowed" },
      },
      {
        name: "recovery key revokes a member",
        entries: [
          ...chain,
          signRaw(nextBody(next, { op: "revoke", id: "phone2" }), RECOVERY, recovery.privateKey),
        ],
        expect: { error: "signer-not-allowed" },
      },
      {
        name: "entry of an op the verifier does not know",
        entries: [
          ...chain,
          signRaw(
            nextBody(next, { op: "rotate", recoveryPk: newRecPk }),
            "phone",
            phone.keys.sign.privateKey,
          ),
        ],
        expect: { error: "bad-schema" },
      },
      {
        // A null refuses the entry rather than reading as absent (#505, #1146).
        name: "entry with a null recoverySig",
        entries: [
          ...chain.slice(0, -1),
          { ...chain[chain.length - 1], recoverySig: null } as unknown as SignedEnvelope,
        ],
        expect: { error: "bad-schema" },
      },
      {
        // Keys and signatures have their algorithms' lengths, so a malformed key never joins (#1283).
        name: "member with a short box key",
        entries: [
          ...chain,
          signRaw(
            nextBody(next, {
              op: "add",
              member: {
                ...evilMachine.member,
                id: "phone3",
                role: "device",
                boxPk: "A".repeat(42),
              },
            }),
            "phone",
            phone.keys.sign.privateKey,
          ),
        ],
        expect: { error: "bad-schema" },
      },
      {
        name: "entry with a short signature",
        entries: chain.map((e, i) =>
          i === chain.length - 1 ? { ...e, sig: e.sig.slice(0, 85) } : e,
        ),
        expect: { error: "bad-schema" },
      },
    ];
  }

  const cases: Case[] = [
    { name: "valid chain", entries: chain, expect: ok(full) },
    { name: "valid chain extends its pin", entries: chain, options: { pin }, expect: ok(full) },
    {
      name: "injected device signed by its own unknown key",
      entries: [
        ...chain,
        signRaw(
          nextBody(full, { op: "add", member: evil.member }),
          "evil",
          evil.keys.sign.privateKey,
        ),
      ],
      expect: { error: "unknown-signer" },
    },
    {
      name: "injected device signed by an unknown key claiming to be phone",
      entries: [
        ...chain,
        signRaw(
          nextBody(full, { op: "add", member: evil.member }),
          "phone",
          evil.keys.sign.privateKey,
        ),
      ],
      expect: { error: "bad-signature" },
    },
    {
      name: "injected device signed by a key claiming to be the recovery key",
      entries: [
        ...chain,
        signRaw(
          nextBody(full, { op: "add", member: evil.member }),
          RECOVERY,
          evil.keys.sign.privateKey,
        ),
      ],
      expect: { error: "bad-signature" },
    },
    {
      name: "tampered signature",
      entries: chain.map((e, i) => (i === 2 ? tamperSig(e) : e)),
      expect: { error: "bad-signature" },
    },
    {
      name: "tampered body, swapped machine key",
      entries: chain.map((e, i) =>
        i === 2 ? { ...e, body: e.body.replace(devbox.member.boxPk, evilMachine.member.boxPk) } : e,
      ),
      expect: { error: "bad-signature" },
    },
    {
      name: "tampered genesis signature",
      entries: chain.map((e, i) => (i === 0 ? tamperSig(e) : e)),
      expect: { error: "bad-signature" },
    },
    {
      name: "server's own chain against the pinned one",
      entries: fakeChain,
      options: { pin },
      expect: { error: "rollback" },
    },
    {
      name: "server's own chain against the recovery key",
      entries: fakeChain,
      options: { recoveryPk },
      expect: { error: "wrong-recovery-key" },
    },
    {
      name: "truncated chain against the pin",
      entries: chain.slice(0, 2),
      options: { pin },
      expect: { error: "rollback" },
    },
    {
      name: "machine signs an entry",
      entries: [
        ...chain,
        signRaw(
          nextBody(full, { op: "add", member: evilMachine.member }),
          "devbox",
          devbox.keys.sign.privateKey,
        ),
      ],
      expect: { error: "signer-not-allowed" },
    },
    {
      name: "revoked device signs an entry",
      entries: [
        ...chain,
        signRaw(
          nextBody(full, { op: "add", member: evil.member }),
          "browser",
          browser.keys.sign.privateKey,
        ),
      ],
      expect: { error: "revoked-signer" },
    },
    {
      name: "recovery key adds a device with add, not recover",
      entries: [
        ...chain,
        signRaw(nextBody(full, { op: "add", member: evil.member }), RECOVERY, recovery.privateKey),
      ],
      expect: { error: "signer-not-allowed" },
    },
    {
      name: "recovery key adds a machine",
      entries: [
        ...chain,
        signRaw(
          nextBody(full, { op: "add", member: evilMachine.member }),
          RECOVERY,
          recovery.privateKey,
        ),
      ],
      expect: { error: "signer-not-allowed" },
    },
    {
      name: "entries reordered",
      entries: [chain[0], chain[2], chain[1]] as SignedEnvelope[],
      expect: { error: "bad-chain" },
    },
    {
      name: "existing keys added under a new id",
      entries: [
        ...chain.slice(0, 3),
        signRaw(
          nextBody(at3, { op: "add", member: { ...phone.member, id: "phone-again" } }),
          "phone",
          phone.keys.sign.privateKey,
        ),
      ],
      expect: { error: "duplicate-member" },
    },
    {
      name: "entry from another account",
      entries: [
        ...chain,
        signRaw(
          { ...nextBody(full, { op: "add", member: evil.member }), account: "acct_other" },
          "phone",
          phone.keys.sign.privateKey,
        ),
      ],
      expect: { error: "wrong-account" },
    },
    {
      name: "later entry replaces the recovery key",
      entries: [
        ...chain,
        signRaw(
          nextBody(full, { op: "add", member: evil.member, recoveryPk: evil.member.signPk }),
          "phone",
          phone.keys.sign.privateKey,
        ),
      ],
      expect: { error: "bad-chain" },
    },
    {
      name: "revoking an already revoked member",
      entries: [
        ...chain,
        signRaw(
          nextBody(full, { op: "revoke", id: "browser" }),
          "phone",
          phone.keys.sign.privateKey,
        ),
      ],
      expect: { error: "unknown-member" },
    },
    {
      name: "genesis signed by another member",
      entries: [
        signRaw(
          JSON.parse((chain[0] as SignedEnvelope).body),
          "browser",
          browser.keys.sign.privateKey,
        ),
      ],
      expect: { error: "bad-genesis" },
    },
    {
      name: "genesis adds a machine",
      entries: [
        genesisEntry({
          account: ACCOUNT,
          device: devbox.member,
          signKey: devbox.keys.sign.privateKey,
          recovery,
          at: T(9),
        }),
      ],
      expect: { error: "bad-genesis" },
    },
    {
      name: "server's genesis copying the real recovery key, no recovery signature",
      entries: [{ ...forgedGenesis, recoverySig: undefined }],
      options: { recoveryPk },
      expect: { error: "bad-genesis" },
    },
    {
      name: "server's genesis copying the real recovery key, signed by another key",
      entries: [forgedGenesis],
      options: { recoveryPk },
      expect: { error: "bad-signature" },
    },
    {
      name: "recovery signature on a later entry",
      entries: chain.map((e, i) =>
        i === 1 ? { ...e, recoverySig: (chain[0] as SignedEnvelope).recoverySig } : e,
      ),
      expect: { error: "bad-chain" },
    },
    {
      name: "wrong account option",
      entries: chain,
      options: { account: "acct_other" },
      expect: { error: "wrong-account" },
    },
    ...recoveryCases(),
  ];
  const directory = {
    note: "verifyDirectory(entries, options) must succeed with `expect` or fail with expect.error.",
    account: ACCOUNT,
    cases,
  };

  // --- envelopes.json ---
  const decisionBody = {
    v: 1 as const,
    id: "dec_1",
    to: ["phone", "phone2"],
    createdAt: T(10),
    question: "Run inference on the Mac while you are away?",
    context: "The bench needs the GPU for about 40 minutes. No: it waits for tonight.",
    options: ["Yes", "No"],
    recommended: "Yes",
    source: { machine: "dev box", project: "localvoxtral", session: "s_42" },
  };
  const answerBody = {
    v: 1 as const,
    id: "ans_1",
    decisionId: "dec_1",
    to: "devbox",
    answeredAt: T(10, 3),
    choice: "Yes",
  };
  const permissionInput = '{"command":"git push origin main","description":"Push the fix"}';
  const permissionBody = {
    v: 1 as const,
    id: "perm_1",
    to: ["phone", "phone2"],
    createdAt: T(10),
    agent: "claude-code" as const,
    tool: "Bash",
    summary: "git push origin main",
    description: "Push the fix",
    input: permissionInput,
    inputHash: hashInput(permissionInput),
    suggestions: [
      {
        label: "Allow git push for this session",
        rule: "Bash(git push:*)",
        scope: "session" as const,
      },
      {
        label: "Always allow git push in localvoxtral",
        rule: "Bash(git push:*)",
        scope: "project" as const,
      },
    ],
    expiresAt: T(10, 9),
    source: { machine: "dev box", project: "localvoxtral", session: "s_42" },
  };
  const permissionAnswerBody = {
    v: 1 as const,
    id: "pans_1",
    permissionId: "perm_1",
    to: "devbox",
    answeredAt: T(10, 1),
    behavior: "allow" as const,
    scope: "session" as const,
    inputHash: permissionBody.inputHash,
  };
  const runBody = {
    v: 1 as const,
    id: "run_1",
    to: ["phone", "phone2"],
    title: "Mac e2e",
    reason: "uses your session and keyboard",
    source: { machine: "dev box", project: "localvoxtral", session: "s_42" },
    startedAt: T(10),
    at: T(10, 2),
    progress: { done: 3, total: 7, unit: "step" as const },
  };
  const settledBody = {
    v: 1 as const,
    id: "set_1",
    itemId: "perm_1",
    to: ["phone", "phone2"],
    outcome: "device" as const,
    device: "phone",
    at: T(10, 1),
  };
  const waitingBody = {
    v: 1 as const,
    id: "wait_1",
    decisionId: "dec_1",
    to: ["phone", "phone2"],
    at: T(10, 20),
    state: "waiting" as const,
  };
  const snoozeBody = {
    v: 1 as const,
    id: "snz_1",
    decisionId: "dec_1",
    to: ["devbox", "phone", "phone2"],
    until: T(18),
    at: T(10, 25),
  };
  const now = new Date(T(12));
  const win = {
    id: "primary",
    label: "5h",
    usedPercent: 20,
    windowMinutes: 300,
    resetsAt: T(12, 30),
  };
  const pace = computePace(win, now);
  const quotaBody = {
    v: 1 as const,
    id: "q_1",
    to: ["phone", "phone2"],
    takenAt: T(12),
    providers: [{ provider: "zai", windows: [{ ...win, pace }] }],
    alerts: alertsFor("zai", { ...win, pace }, now),
  };
  const devices = [phone.member, phone2.member];
  const signedDecision = sign("decision", decisionBody, "devbox", devbox.keys.sign.privateKey);

  const signatures = [
    { name: "valid", envelope: signedDecision, signPk: devbox.member.signPk, expect: "ok" },
    {
      name: "tampered body",
      envelope: { ...signedDecision, body: signedDecision.body.replace('"Yes"', '"No!"') },
      signPk: devbox.member.signPk,
      expect: "bad-signature",
    },
    {
      name: "tampered signature",
      envelope: tamperSig(signedDecision),
      signPk: devbox.member.signPk,
      expect: "bad-signature",
    },
    {
      name: "kind changed",
      envelope: { ...signedDecision, kind: "quota" },
      signPk: devbox.member.signPk,
      expect: "bad-signature",
    },
    {
      name: "signer changed",
      envelope: { ...signedDecision, signer: "evilbox" },
      signPk: devbox.member.signPk,
      expect: "bad-signature",
    },
    {
      name: "another key",
      envelope: signedDecision,
      signPk: evilMachine.member.signPk,
      expect: "bad-signature",
    },
  ];

  /** Seals any envelope without the checks `seal` makes, to build hostile items. */
  const rawSeal = (
    kind: SealedItem["kind"],
    id: string,
    env: SignedEnvelope,
    to: Member[],
  ): SealedItem => ({
    v: 1,
    kind,
    id,
    from: env.signer,
    ...(kind === "answer" || kind === "snooze" ? { re: "dec_1" } : {}),
    ...(kind === "snooze" ? { wakeAt: T(18) } : {}),
    ...(kind === "permission-answer" || kind === "settled" ? { re: "perm_1" } : {}),
    boxes: to.map((m) => ({
      to: m.id,
      box: toB64(
        sodium.crypto_box_seal(
          utf8(JSON.stringify(env)),
          sodium.from_base64(m.boxPk, sodium.base64_variants.URLSAFE_NO_PADDING),
        ),
      ),
    })),
  });

  const decisionItem = seal("decision", decisionBody, signer(devbox), devices);
  const corrupted: SealedItem = {
    ...decisionItem,
    boxes: decisionItem.boxes.map((b) => ({ ...b, box: `${b.box.slice(0, -4)}AAAA` })),
  };
  const sealed = [
    {
      name: "decision after a byte order mark",
      // TextDecoder drops a leading byte order mark, so the envelope still parses (#1082).
      item: {
        ...decisionItem,
        boxes: [phone.member].map((m) => ({
          to: m.id,
          box: toB64(
            sodium.crypto_box_seal(
              utf8(`\uFEFF${JSON.stringify(signedDecision)}`),
              sodium.from_base64(m.boxPk, sodium.base64_variants.URLSAFE_NO_PADDING),
            ),
          ),
        })),
      },
      recipient: "phone",
      expect: { body: decisionBody, signer: "devbox" },
    },
    {
      name: "a box that is not base64url",
      item: { ...decisionItem, boxes: [{ to: "phone", box: "AAAAA" }] },
      recipient: "phone",
      expect: { error: "cannot-open" },
    },
    // A null refuses the item rather than reading as absent (#505, #1146).
    {
      name: "an item with a null re",
      item: { ...decisionItem, re: null },
      recipient: "phone",
      expect: { error: "bad-schema" },
    },
    {
      name: "an envelope with a null recoverySig",
      item: rawSeal(
        "decision",
        decisionItem.id,
        {
          ...signedDecision,
          recoverySig: null,
        } as unknown as SignedEnvelope,
        devices,
      ),
      recipient: "phone",
      expect: { error: "bad-schema" },
    },
    {
      name: "an item that is quiet: false",
      item: { ...decisionItem, quiet: false },
      recipient: "phone",
      expect: { error: "bad-schema" },
    },
    {
      name: "decision for phone",
      item: decisionItem,
      recipient: "phone",
      expect: { body: decisionBody, signer: "devbox" },
    },
    {
      name: "decision for the new phone",
      item: decisionItem,
      recipient: "phone2",
      expect: { body: decisionBody, signer: "devbox" },
    },
    {
      name: "answer for the machine",
      item: seal("answer", answerBody, signer(phone), [devbox.member]),
      recipient: "devbox",
      expect: { body: answerBody, signer: "phone" },
    },
    {
      name: "quota snapshot",
      item: seal("quota", quotaBody, signer(devbox), devices),
      recipient: "phone",
      expect: { body: quotaBody, signer: "devbox" },
    },
    {
      name: "permission prompt",
      item: seal("permission", permissionBody, signer(devbox), devices),
      recipient: "phone",
      expect: { body: permissionBody, signer: "devbox" },
    },
    {
      name: "permission answer for the machine",
      item: seal("permission-answer", permissionAnswerBody, signer(phone), [devbox.member]),
      recipient: "devbox",
      expect: { body: permissionAnswerBody, signer: "phone" },
    },
    {
      name: "settled notice",
      item: seal("settled", settledBody, signer(devbox), devices),
      recipient: "phone2",
      expect: { body: settledBody, signer: "devbox" },
    },
    {
      name: "run",
      item: seal("run", runBody, signer(devbox), devices),
      recipient: "phone",
      expect: { body: runBody, signer: "devbox" },
    },
    {
      name: "run signed by a device",
      item: rawSeal(
        "run",
        "run_1",
        sign("run", runBody, "phone2", phone2.keys.sign.privateKey),
        devices,
      ),
      recipient: "phone",
      expect: { error: "signer-not-allowed" },
    },
    {
      name: "permission answer signed by a machine",
      item: rawSeal(
        "permission-answer",
        "pans_1",
        sign("permission-answer", permissionAnswerBody, "devbox", devbox.keys.sign.privateKey),
        [devbox.member],
      ),
      recipient: "devbox",
      expect: { error: "signer-not-allowed" },
    },
    {
      name: "permission prompt signed by a device",
      item: rawSeal(
        "permission",
        "perm_1",
        sign("permission", permissionBody, "phone2", phone2.keys.sign.privateKey),
        devices,
      ),
      recipient: "phone",
      expect: { error: "signer-not-allowed" },
    },
    {
      name: "permission answer whose re names another permission",
      item: {
        ...seal("permission-answer", permissionAnswerBody, signer(phone), [devbox.member]),
        re: "perm_9",
      },
      recipient: "devbox",
      expect: { error: "id-mismatch" },
    },
    {
      name: "decision answer inside a permission answer item",
      item: rawSeal(
        "permission-answer",
        "ans_1",
        sign("answer", answerBody, "phone", phone.keys.sign.privateKey),
        [devbox.member],
      ),
      recipient: "devbox",
      expect: { error: "wrong-kind" },
    },
    {
      name: "snooze for another device",
      item: seal("snooze", snoozeBody, signer(phone), [devbox.member, ...devices]),
      recipient: "phone2",
      expect: { body: snoozeBody, signer: "phone" },
    },
    {
      name: "snooze for the machine",
      item: seal("snooze", snoozeBody, signer(phone), [devbox.member, ...devices]),
      recipient: "devbox",
      expect: { body: snoozeBody, signer: "phone" },
    },
    {
      name: "snooze whose wakeAt is not its until",
      item: {
        ...seal("snooze", snoozeBody, signer(phone), [devbox.member, ...devices]),
        wakeAt: T(9),
      },
      recipient: "phone2",
      expect: { error: "id-mismatch" },
    },
    {
      name: "snooze without wakeAt",
      item: (({ wakeAt: _, ...rest }) => rest)(
        seal("snooze", snoozeBody, signer(phone), [devbox.member, ...devices]),
      ),
      recipient: "phone2",
      expect: { error: "id-mismatch" },
    },
    {
      name: "decision with a wakeAt",
      item: { ...decisionItem, wakeAt: T(18) },
      recipient: "phone",
      expect: { error: "id-mismatch" },
    },
    {
      name: "snooze signed by a machine",
      item: rawSeal(
        "snooze",
        "snz_1",
        sign("snooze", snoozeBody, "devbox", devbox.keys.sign.privateKey),
        [phone2.member],
      ),
      recipient: "phone2",
      expect: { error: "signer-not-allowed" },
    },
    {
      name: "no box for this member",
      item: decisionItem,
      recipient: "browser",
      expect: { error: "wrong-recipient" },
    },
    {
      name: "corrupted box",
      item: corrupted,
      recipient: "phone",
      expect: { error: "cannot-open" },
    },
    {
      name: "decision signed by a device",
      item: rawSeal(
        "decision",
        "dec_1",
        sign("decision", decisionBody, "phone2", phone2.keys.sign.privateKey),
        devices,
      ),
      recipient: "phone",
      expect: { error: "signer-not-allowed" },
    },
    {
      name: "decision from a machine not in the directory",
      item: rawSeal(
        "decision",
        "dec_1",
        sign("decision", decisionBody, "evilbox", evilMachine.keys.sign.privateKey),
        devices,
      ),
      recipient: "phone",
      expect: { error: "unknown-signer" },
    },
    {
      name: "decision signed by another key claiming to be devbox",
      item: rawSeal(
        "decision",
        "dec_1",
        sign("decision", decisionBody, "devbox", evilMachine.keys.sign.privateKey),
        devices,
      ),
      recipient: "phone",
      expect: { error: "bad-signature" },
    },
    {
      name: "answer from a revoked device",
      item: rawSeal(
        "answer",
        "ans_1",
        sign("answer", answerBody, "browser", browser.keys.sign.privateKey),
        [devbox.member],
      ),
      recipient: "devbox",
      expect: { error: "revoked-signer" },
    },
    {
      name: "decision re-sealed to a member it does not name",
      item: rawSeal(
        "decision",
        "dec_1",
        sign(
          "decision",
          { ...decisionBody, to: ["phone2"] },
          "devbox",
          devbox.keys.sign.privateKey,
        ),
        [phone.member],
      ),
      recipient: "phone",
      expect: { error: "wrong-recipient" },
    },
    {
      name: "item id differs from the signed id",
      item: { ...decisionItem, id: "dec_2" },
      recipient: "phone",
      expect: { error: "id-mismatch" },
    },
    {
      name: "answer whose re names another decision",
      item: { ...seal("answer", answerBody, signer(phone), [devbox.member]), re: "dec_9" },
      recipient: "devbox",
      expect: { error: "id-mismatch" },
    },
    {
      name: "signed answer inside a decision item",
      item: rawSeal(
        "decision",
        "ans_1",
        sign("answer", answerBody, "phone", phone.keys.sign.privateKey),
        [devbox.member],
      ),
      recipient: "devbox",
      expect: { error: "wrong-kind" },
    },
  ];
  const envelopes = {
    note: "Signatures: verify(envelope, signPk). Sealed: open(item, recipient, directory) where the directory is directory.json's valid chain; boxes differ on every run.",
    signatures,
    sealed,
  };

  // --- pairing.json ---
  const CHECK_KEY = encodeCrockford(new Uint8Array(10).map((_, i) => 200 - i * 13));
  const codeBytes = new Uint8Array(15).map((_, i) => i * 17);
  const code = parsePairingCode(encodeCrockford(codeBytes));
  const requestBody = {
    v: 1 as const,
    rendezvous: code.rendezvous,
    role: "machine" as const,
    id: "devbox",
    name: "dev box",
    ...publicKeys(devbox.keys),
    at: T(9, 9),
  };
  const request = pairingRequest(requestBody, code);
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: code.rendezvous,
      account: ACCOUNT,
      length: 3,
      head: at3.head,
      approver: "phone",
    },
    code,
  );
  const otherCode = parsePairingCode(encodeCrockford(new Uint8Array(15).fill(9)));
  const pairing = {
    note: "Code = Crockford base32 of 15 bytes: 8 characters of rendezvous, 16 of secret.",
    codeBytes: toB64(codeBytes),
    code: formatPairingCode(code),
    rendezvous: code.rendezvous,
    secret: code.secret,
    key: toB64(pairingKey(code)),
    claim: { secret: toB64(seed(7)), hash: claimHash(toB64(seed(7))) },
    check: {
      note: "checkCode(entries, id): directory.json's chain, the dev box's add entry",
      entries: chain.slice(0, 3),
      id: devbox.member.id,
      expect: checkCode(chain.slice(0, 3), devbox.member.id),
      key: CHECK_KEY,
      proof: checkProof(chain.slice(0, 3), devbox.member.id, CHECK_KEY),
    },
    parse: [
      { input: formatPairingCode(code).toLowerCase(), expect: formatPairingCode(code) },
      { input: "0123 4567 89ab cdef ghjk mnpq", expect: "0123-4567-89AB-CDEF-GHJK-MNPQ" },
      { input: "o1l1-I111-1111-1111-1111-1111", expect: "0111-1111-1111-1111-1111-1111" },
      // JavaScript's \s: U+00A0, U+3000 and U+FEFF are in it, U+0085 is not (#1145).
      {
        input: "0123\u00A04567\u300089ab\uFEFFcdef ghjk mnpq",
        expect: "0123-4567-89AB-CDEF-GHJK-MNPQ",
      },
      { input: "0123\u00854567 89ab cdef ghjk mnpq", expect: "bad-encoding" },
      { input: "0123-4567-89AB-CDEF-GHJK-MNPU", expect: "bad-encoding" },
      { input: "0123-4567", expect: "bad-encoding" },
    ],
    links: [
      {
        note: "pairingLink(server, code); codeFromLink takes what follows #, or the whole text",
        server: "https://starbridge.run/",
        link: pairingLink("https://starbridge.run/", code),
        expect: formatPairingCode(codeFromLink(pairingLink("https://starbridge.run/", code))),
      },
      {
        input: `https://example.org/pair#${formatPairingCode(code).toLowerCase()}`,
        expect: formatPairingCode(code),
      },
      { input: "https://starbridge.run/pair#0123-4567", expect: "bad-encoding" },
    ],
    keyLinks: [
      {
        note: "machineQrText(server, code, key): the server and check key in the query, the code after #, with no scheme, which only the app's scanner reads; checkKeyFromLink reads the key back",
        server: "https://starbridge.example:8443/",
        key: CHECK_KEY,
        link: machineQrText("https://starbridge.example:8443/", code, CHECK_KEY),
        expect: CHECK_KEY,
      },
      { input: `starbridge-pair?x=1&k=${CHECK_KEY.toLowerCase()}#ABCD`, expect: CHECK_KEY },
      { input: `starbridge-pair#k=${CHECK_KEY}`, expect: null },
      { input: "starbridge-pair?k=0123#ABCD", expect: null },
      { input: "starbridge-pair?k=0123456789ABCDEU#ABCD", expect: null },
      { input: pairingLink("https://starbridge.run", code), expect: null },
    ],
    bind: (() => {
      const nonce = toB64(seed(11));
      const sig = toB64(
        sodium.crypto_sign_detached(
          bindMessage(ACCOUNT, "phone", nonce),
          phone.keys.sign.privateKey,
        ),
      );
      return {
        note: "verifyBind({account, member, nonce, sig}, signPk); message is bindMessage's bytes.",
        account: ACCOUNT,
        member: "phone",
        nonce,
        message: toB64(bindMessage(ACCOUNT, "phone", nonce)),
        sig,
        signPk: phone.member.signPk,
      };
    })(),
    request: { message: request, body: requestBody },
    approval: { message: approval, body: JSON.parse(approval.body) },
    bad: [
      {
        name: "request with the machine's keys swapped",
        kind: "request",
        message: {
          ...request,
          body: request.body.replace(devbox.member.boxPk, evilMachine.member.boxPk),
        },
        code: formatPairingCode(code),
        expect: "bad-mac",
      },
      {
        name: "request made by someone without the code",
        kind: "request",
        message: pairingRequest({ ...requestBody, rendezvous: otherCode.rendezvous }, otherCode),
        code: formatPairingCode(code),
        expect: "bad-mac",
      },
      {
        name: "approval for the server's own directory",
        kind: "approval",
        message: { ...approval, body: approval.body.replace(at3.head, fakeDir.head) },
        code: formatPairingCode(code),
        expect: "bad-mac",
      },
      {
        name: "request with a short signing key",
        kind: "request",
        message: macUnchecked(
          "pairing-request",
          { ...requestBody, signPk: requestBody.signPk.slice(0, 42) },
          pairingKey(code),
        ),
        code: formatPairingCode(code),
        expect: "bad-schema",
      },
      {
        name: "request with a long MAC",
        kind: "request",
        message: { ...request, mac: `${request.mac}AA` },
        code: formatPairingCode(code),
        expect: "bad-schema",
      },
    ],
  };

  // --- join.json ---
  const ephemeral = (n: number) => sodium.crypto_box_seed_keypair(seed(n));
  const joiner = ephemeral(21);
  const approver = ephemeral(22);
  const server = ephemeral(23);
  const joinId = encodeCrockford(new Uint8Array([1, 2, 3, 4, 5]));
  const joinBody = {
    v: 1 as const,
    join: joinId,
    account: ACCOUNT,
    id: "phone2",
    name: "New Pixel",
    ...publicKeys(phone2.keys),
    at: T(9, 19),
  };
  const joinText = joinRequest(joinBody);
  const commitment = joinCommitment(joiner.publicKey, joinText);
  const joinerSide = joinerKeys({
    mine: joiner,
    approverKey: toB64(approver.publicKey),
    request: joinText,
  });
  const approverSide = approverKeys({
    mine: approver,
    joinerKey: toB64(joiner.publicKey),
    request: joinText,
    commitment,
  });
  if (joinerSide.digits !== approverSide.digits) throw new Error("join digits differ");
  const joinApprovalBody = {
    v: 1 as const,
    join: joinId,
    account: ACCOUNT,
    length: full.length,
    head: full.head,
    approver: "phone",
  };
  const joinApprovalMsg = joinApproval(joinApprovalBody, approverSide);
  // The server in the middle: its own key to each side.
  const mitm = approverKeys({
    mine: approver,
    joinerKey: toB64(server.publicKey),
    request: joinText,
    commitment: joinCommitment(server.publicKey, joinText),
  });
  const lowOrder = new Uint8Array(32);
  lowOrder[0] = 1;
  const join = {
    note: "Ephemeral X25519 keys are crypto_box_seed_keypair of a seed filled with n. Digits: first 4 bytes of the SAS hash, big-endian, mod 1000000, 6 digits.",
    joiner: {
      seed: toB64(seed(21)),
      publicKey: toB64(joiner.publicKey),
      privateKey: toB64(joiner.privateKey),
    },
    approver: {
      seed: toB64(seed(22)),
      publicKey: toB64(approver.publicKey),
      privateKey: toB64(approver.privateKey),
    },
    server: {
      seed: toB64(seed(23)),
      publicKey: toB64(server.publicKey),
      privateKey: toB64(server.privateKey),
    },
    request: { body: joinBody, text: joinText },
    commitment,
    mac: toB64(approverSide.mac),
    digits: approverSide.digits,
    approval: { message: joinApprovalMsg, body: joinApprovalBody },
    bad: [
      {
        name: "revealed key that does not open the commitment",
        side: "approver",
        joinerKey: toB64(server.publicKey),
        request: joinText,
        commitment,
        expect: "bad-commitment",
      },
      {
        name: "request changed after the commitment",
        side: "approver",
        joinerKey: toB64(joiner.publicKey),
        request: joinRequest({ ...joinBody, ...publicKeys(evil.keys) }),
        commitment,
        expect: "bad-commitment",
      },
      {
        name: "low-order approver key",
        side: "joiner",
        approverKey: toB64(lowOrder),
        request: joinText,
        expect: "bad-key",
      },
      {
        name: "all-zero approver key",
        side: "joiner",
        approverKey: toB64(new Uint8Array(32)),
        request: joinText,
        expect: "bad-key",
      },
      {
        name: "short approver key",
        side: "joiner",
        approverKey: toB64(new Uint8Array(31)),
        request: joinText,
        expect: "bad-encoding",
      },
      {
        name: "approval made under the server's key",
        side: "approval",
        message: joinApproval(joinApprovalBody, mitm),
        expect: "bad-mac",
      },
      {
        name: "approval for the server's own directory",
        side: "approval",
        message: {
          ...joinApprovalMsg,
          body: joinApprovalMsg.body.replace(full.head, fakeDir.head),
        },
        expect: "bad-mac",
      },
      {
        name: "approval for another join",
        side: "approval",
        message: joinApproval({ ...joinApprovalBody, join: "ZZZZZZZZ" }, approverSide),
        expect: "id-mismatch",
      },
      {
        name: "approval with a short head",
        side: "approval",
        message: macUnchecked(
          "join-approval",
          { ...joinApprovalBody, head: full.head.slice(0, 42) },
          approverSide.mac,
        ),
        expect: "bad-schema",
      },
    ],
  };

  // --- pace.json ---
  const paceCases = [
    { name: "behind, resets soon: unused headroom", window: win, now: T(12) },
    {
      name: "ahead: runs out before reset",
      window: { ...win, usedPercent: 80, resetsAt: T(14) },
      now: T(12),
    },
    {
      name: "on track",
      window: { ...win, usedPercent: 50, resetsAt: T(14, 30) },
      now: T(12),
    },
    {
      name: "too early to tell",
      window: { ...win, usedPercent: 3, resetsAt: T(16, 50) },
      now: T(12),
    },
    {
      name: "exhausted",
      window: { ...win, usedPercent: 100, resetsAt: T(14) },
      now: T(12),
    },
    {
      name: "weekly, 80% used, a day left: low at 20, no unused headroom",
      window: {
        id: "secondary",
        label: "week",
        usedPercent: 80,
        windowMinutes: 10080,
        resetsAt: "2026-10-05T12:00:00Z",
      },
      now: T(12),
    },
    {
      name: "monthly credits, 3 days left, 40% used",
      window: {
        id: "mistral-monthly-plan",
        label: "vibe",
        usedPercent: 40,
        windowMinutes: 43200,
        resetsAt: "2026-10-07T12:00:00Z",
      },
      now: T(12),
    },
    {
      name: "unknown length",
      window: { ...win, windowMinutes: null },
      now: T(12),
    },
    {
      name: "5-hour, 61 minutes left: too early for unused headroom",
      window: { ...win, resetsAt: T(13, 1) },
      now: T(12),
    },
    {
      name: "weekly, 8 hours left, half unused",
      window: {
        id: "secondary",
        label: "week",
        usedPercent: 45,
        windowMinutes: 10080,
        resetsAt: T(20, 0),
      },
      now: T(12),
    },
    {
      name: "45% left: low at 50",
      window: { ...win, usedPercent: 55, resetsAt: T(16) },
      now: T(12),
    },
    {
      name: "reset passed: no alert",
      window: { ...win, usedPercent: 90, resetsAt: T(11, 30) },
      now: T(12),
    },
    {
      name: "no length, 15% left: low at 20 only",
      window: { ...win, usedPercent: 85, windowMinutes: null },
      now: T(12),
    },
  ].map((c) => {
    const p = computePace(c.window, new Date(c.now));
    return {
      ...c,
      provider: "zai",
      expectPace: p,
      expectAlerts: alertsFor("zai", { ...c.window, pace: p }, new Date(c.now)),
    };
  });
  const paceFile = {
    note: "computePace(window, now) and alertsFor(provider, window+pace, now) with the default rule.",
    rule: DEFAULT_ALERT_RULE,
    cases: paceCases,
  };

  // --- context.json ---
  const contextCases = [
    [
      "plain lines",
      "The migration locks orders for 4 minutes.\n\nAfter the backup: done by 18:30.\r\nNow: checkouts fail.",
    ],
    ["inline code", "Run `starbridge wait d_1` again; a lone ` stays."],
    [
      "bold option labels",
      "**After the backup:** done by 18:30.\n**Now:** checkouts fail for 4 minutes.",
    ],
    ["bold wraps code", "**`first-keys`:** a new account saved its key."],
    ["bold needs text inside", "2 ** 10 and ** spaced ** and **** stay."],
    ["bullets", "- one\n* two\n• three\n  - indented\n-not a bullet"],
    ["numbers", "1. first\n2) second\n10. tenth\n1.5 is a number"],
    ["heading", "## Options\nA: keep it"],
    ["bare URL", "See https://github.com/acme/shop/pull/41. Or (https://x.dev/a)."],
    [
      "Markdown link",
      "Read [the PR](https://github.com/acme/shop/pull/41) first; [no](javascript:x) stays.",
    ],
    ["fenced code", "Before:\n```bash\n  make build\n\n  make e2e\n```\nAfter."],
    ["unclosed fence", "Error:\n```\nTypeError: x is undefined"],
    ["empty fence", "```\n```\nText"],
    ["outside the subset", "*em* _u_ ~~gone~~ > quote | a | b |"],
    // JavaScript's \s and `.` draw these lines: U+FEFF is space and U+001F is not, and `.`
    // matches U+0085 (#1082).
    ["spaces as JavaScript reads them", "\uFEFF- one\ntwo\u001F\n- three\u0085four"],
  ].map(([name, text]) => ({
    name,
    text,
    blocks: parseContext(text ?? ""),
    plain: contextText(text ?? ""),
  }));
  const contextFile = {
    note: "parseContext(text) and contextText(text): the context subset every client renders (#969).",
    cases: contextCases,
  };

  // --- links.json ---
  // Written by hand: each case is what the chip must show, so a client that drifts fails here.
  const gh = "https://github.com/T0mSIlver/starbridge";
  const linkCases: {
    name: string;
    url: string;
    title?: string;
    project?: string;
    expect: { icon?: string; label: string };
  }[] = [
    // GitHub references (#971): the icon says what the number is, so the title gives way.
    {
      name: "pull request",
      url: `${gh}/pull/86/files#diff`,
      project: "starbridge",
      expect: { icon: "pull", label: "#86" },
    },
    {
      name: "pull request over its title",
      url: `${gh}/pull/86`,
      title: "Merge plan",
      project: "starbridge",
      expect: { icon: "pull", label: "#86" },
    },
    {
      name: "issue, host and repo in any case",
      url: "https://GitHub.com/T0mSIlver/Starbridge/issues/171",
      project: "starbridge",
      expect: { icon: "issue", label: "#171" },
    },
    {
      name: "issue on www",
      url: "https://www.github.com/T0mSIlver/starbridge/issues/2?q=1",
      project: "starbridge",
      expect: { icon: "issue", label: "#2" },
    },
    {
      name: "discussion",
      url: `${gh}/discussions/12`,
      project: "starbridge",
      expect: { icon: "discussion", label: "#12" },
    },
    {
      name: "release tag",
      url: `${gh}/releases/tag/v0.1.2`,
      project: "starbridge",
      expect: { icon: "release", label: "v0.1.2" },
    },
    {
      name: "release tag, percent-decoded",
      url: `${gh}/releases/tag/v1.0-beta%2B1`,
      project: "starbridge",
      expect: { icon: "release", label: "v1.0-beta+1" },
    },
    {
      name: "release tag, a plus stays a plus",
      url: `${gh}/releases/tag/v1+2`,
      project: "starbridge",
      expect: { icon: "release", label: "v1+2" },
    },
    {
      name: "release tag, malformed escape as written",
      url: `${gh}/releases/tag/v1%E0%A4`,
      project: "starbridge",
      expect: { icon: "release", label: "v1%E0%A4" },
    },
    {
      name: "release tag, a bidi override stays encoded",
      url: `${gh}/releases/tag/v1%E2%80%AEgpj.exe`,
      project: "starbridge",
      expect: { icon: "release", label: "v1%E2%80%AEgpj.exe" },
    },
    {
      name: "release tag, a newline stays encoded",
      url: `${gh}/releases/tag/v1%0Ax`,
      project: "starbridge",
      expect: { icon: "release", label: "v1%0Ax" },
    },
    {
      name: "commit, short hash",
      url: `${gh}/commit/63141E89a2b4c`,
      project: "starbridge",
      expect: { icon: "commit", label: "63141e8" },
    },
    {
      name: "another repo leads",
      url: "https://github.com/steipete/CodexBar/pull/412",
      project: "starbridge",
      expect: { icon: "pull", label: "CodexBar#412" },
    },
    {
      name: "another repo's release",
      url: "https://github.com/steipete/CodexBar/releases/tag/v1.2",
      project: "starbridge",
      expect: { icon: "release", label: "CodexBar v1.2" },
    },
    {
      name: "no session project: the repo leads",
      url: `${gh}/pull/86`,
      expect: { icon: "pull", label: "starbridge#86" },
    },
    {
      name: "a long tag is clipped",
      url: `${gh}/releases/tag/${"v".repeat(60)}`,
      project: "starbridge",
      expect: { icon: "release", label: `${"v".repeat(39)}…` },
    },
    // Other GitHub pages: the title, else a label of their own.
    {
      name: "Actions run",
      url: `${gh}/actions/runs/18234567890/job/5`,
      project: "starbridge",
      expect: { icon: "run", label: "Actions run" },
    },
    {
      name: "Actions run with a title",
      url: `${gh}/actions/runs/18234567890`,
      title: "CI on #934",
      project: "starbridge",
      expect: { icon: "run", label: "CI on #934" },
    },
    {
      name: "file reads as its name",
      url: `${gh}/blob/main/spec/items.md#L27-L36`,
      project: "starbridge",
      expect: { icon: "file", label: "items.md" },
    },
    {
      name: "file on a branch with slashes",
      url: `${gh}/blob/t/943-mockups/mock943/index.html?plain=1`,
      project: "starbridge",
      expect: { icon: "file", label: "index.html" },
    },
    {
      name: "file in another repo",
      url: "https://github.com/T0mSIlver/starbridge-planning/blob/main/launch/notes.md",
      project: "starbridge",
      expect: { icon: "file", label: "notes.md" },
    },
    {
      name: "file name percent-decoded",
      url: `${gh}/blob/main/docs/r%C3%A9sum%C3%A9%20v2.md`,
      expect: { icon: "file", label: "résumé v2.md" },
    },
    {
      name: "file with a title",
      url: `${gh}/blob/main/README.md`,
      title: "The README",
      expect: { icon: "file", label: "The README" },
    },
    {
      name: "blob without a file is a page",
      url: `${gh}/blob/main`,
      project: "starbridge",
      expect: { icon: "github", label: "T0mSIlver/starbridge/blob/main" },
    },
    {
      name: "folder is a page",
      url: `${gh}/tree/main/docs`,
      project: "starbridge",
      expect: { icon: "github", label: "T0mSIlver/starbridge/tree/main/docs" },
    },
    {
      name: "a list of pulls is a page",
      url: `${gh}/pulls`,
      project: "starbridge",
      expect: { icon: "github", label: "T0mSIlver/starbridge/pulls" },
    },
    {
      name: "a new pull is a page",
      url: `${gh}/pull/new/branch`,
      project: "starbridge",
      expect: { icon: "github", label: "T0mSIlver/starbridge/pull/new/branch" },
    },
    {
      name: "a number past 20 digits is a page",
      url: `${gh}/pull/${"1".repeat(21)}`,
      project: "starbridge",
      expect: { icon: "github", label: `T0mSIlver/starbridge/pull/${"1".repeat(13)}…` },
    },
    {
      name: "a commit that isn't a hash is a page",
      url: `${gh}/commit/main`,
      project: "starbridge",
      expect: { icon: "github", label: "T0mSIlver/starbridge/commit/main" },
    },
    {
      name: "GitHub's home",
      url: "https://github.com/",
      expect: { icon: "github", label: "GitHub" },
    },
    {
      name: "a double slash is a page",
      url: "https://github.com//starbridge/pull/1",
      expect: { icon: "github", label: "/starbridge/pull/1" },
    },
    // Claude artifacts.
    {
      name: "artifact",
      url: "https://claude.ai/artifact/KBq5zAgWw9eZbRwsv2oXU9",
      expect: { icon: "artifact", label: "Claude artifact" },
    },
    {
      name: "Claude Code artifact",
      url: "https://claude.ai/code/artifact/7c1d2e3f-0000-4000-8000-000000000000",
      expect: { icon: "artifact", label: "Claude artifact" },
    },
    {
      name: "public artifact with a title",
      url: "https://claude.ai/public/artifacts/0b3f",
      title: "Mockups",
      expect: { icon: "artifact", label: "Mockups" },
    },
    {
      name: "a chat is not an artifact",
      url: "https://claude.ai/chat/0b3f",
      expect: { label: "claude.ai/chat/0b3f" },
    },
    {
      name: "a page under an artifact is not one",
      url: "https://claude.ai/artifact/0b3f/edit",
      expect: { label: "claude.ai/artifact/0b3f/edit" },
    },
    {
      name: "an artifact elsewhere is not one",
      url: "https://example.com/artifact/0b3f",
      expect: { label: "example.com/artifact/0b3f" },
    },
    // Anything else, or not matched exactly: the plain chip, as before #1577.
    {
      name: "another host reads as host and path",
      url: "https://www.example.com/",
      expect: { label: "example.com" },
    },
    {
      name: "another host with a title",
      url: "https://play.google.com/console/u/1/developers/1/app/2/publishing",
      title: "Play Console",
      expect: { label: "Play Console · play.google.com" },
    },
    {
      name: "a long path is clipped",
      url: `https://example.com/${"a".repeat(60)}`,
      expect: { label: `example.com/${"a".repeat(27)}…` },
    },
    {
      name: "an emoji is never cut in half",
      url: `${gh}/blob/main/${"a".repeat(38)}%F0%9F%98%80%F0%9F%98%80b`,
      expect: { icon: "file", label: `${"a".repeat(38)}\u{1F600}…` },
    },
    {
      name: "look-alike host",
      url: "https://github.com.evil.com/T0mSIlver/starbridge/pull/1",
      expect: { label: "github.com.evil.com/T0mSIlver/starbridg…" },
    },
    {
      name: "subdomain",
      url: "https://gist.github.com/o/1",
      expect: { label: "gist.github.com/o/1" },
    },
    {
      name: "punycode host",
      url: "https://xn--gthub-n4a.com/o/r/pull/1",
      expect: { label: "xn--gthub-n4a.com/o/r/pull/1" },
    },
    {
      name: "user before the host: as written",
      url: "https://github.com@evil.com/o/r/pull/1",
      expect: { label: "https://github.com@evil.com/o/r/pull/1" },
    },
    {
      name: "user and password: as written",
      url: "https://a:b@github.com/o/r/pull/1",
      expect: { label: "https://a:b@github.com/o/r/pull/1" },
    },
    {
      name: "port: as written",
      url: "https://github.com:443/o/r/pull/1",
      expect: { label: "https://github.com:443/o/r/pull/1" },
    },
    {
      name: "backslash: as written",
      url: "https://evil.com\\@github.com/o/r/pull/1",
      expect: { label: "https://evil.com\\@github.com/o/r/pull/1" },
    },
    {
      name: "a trailing dot is another host",
      url: "https://github.com./o/r/pull/1",
      expect: { label: "github.com./o/r/pull/1" },
    },
    {
      name: "the host only in the fragment",
      url: "https://evil.com#github.com/o/r/pull/1",
      expect: { label: "evil.com" },
    },
    {
      name: "http is not https",
      url: "http://github.com/o/r/pull/1",
      expect: { label: "http://github.com/o/r/pull/1" },
    },
    {
      name: "a soft hyphen in a file name stays encoded",
      url: `${gh}/blob/main/pay%C2%ADload.exe`,
      expect: { icon: "file", label: "pay%C2%ADload.exe" },
    },
    {
      name: "a combining grapheme joiner stays encoded",
      url: `${gh}/blob/main/a%CD%8Fb.md`,
      expect: { icon: "file", label: "a%CD%8Fb.md" },
    },
    {
      name: "a Mongolian vowel separator stays encoded",
      url: `${gh}/blob/main/a%E1%A0%8Eb.md`,
      expect: { icon: "file", label: "a%E1%A0%8Eb.md" },
    },
    {
      name: "a variation selector in a tag stays encoded",
      url: `${gh}/releases/tag/v1%EF%B8%8F`,
      project: "starbridge",
      expect: { icon: "release", label: "v1%EF%B8%8F" },
    },
    {
      name: "a tag character stays encoded",
      url: `${gh}/blob/main/a%F3%A0%80%81b.md`,
      expect: { icon: "file", label: "a%F3%A0%80%81b.md" },
    },
    {
      name: "dot segments: as written",
      url: `${gh}/pull/123/../../issues/999`,
      project: "starbridge",
      expect: { label: "https://github.com/T0mSIlver/starbridge…" },
    },
    {
      name: "encoded dot segments: as written",
      url: "https://github.com/o/r/pull/1/%2e%2E/%2e./issues/2",
      expect: { label: "https://github.com/o/r/pull/1/%2e%2E/%2…" },
    },
    {
      name: "a single dot segment: as written",
      url: "https://claude.ai/./artifact/abc",
      expect: { label: "https://claude.ai/./artifact/abc" },
    },
    {
      name: "dots inside a name are no dot segment",
      url: `${gh}/blob/main/a..b`,
      expect: { icon: "file", label: "a..b" },
    },
    {
      name: "the project matches the repo by ASCII case only (Kelvin sign)",
      url: "https://github.com/o/k/pull/1",
      project: "\u212A",
      expect: { icon: "pull", label: "k#1" },
    },
    {
      name: "the project matches the repo by ASCII case only (dotless i)",
      url: "https://github.com/o/i/pull/1",
      project: "\u0131",
      expect: { icon: "pull", label: "i#1" },
    },
    { name: "empty host: as written", url: "https://%", expect: { label: "https://%" } },
    // A title on another host than GitHub's is followed by the host (#1722).
    {
      name: "a GitHub reference as the title of another host",
      url: "https://evil.example/pull/123",
      title: "starbridge#123",
      expect: { label: "starbridge#123 · evil.example" },
    },
    {
      name: "a long title gives way to the host",
      url: "https://docs.example.com/guide",
      title: "A very long title that would push the host out of the chip",
      expect: { label: "A very long title th… · docs.example.com" },
    },
    {
      name: "a long host keeps its end",
      url: "https://github.com.a-very-long-subdomain-chain.evil.example/x",
      title: "Docs",
      expect: { label: "Docs · …-subdomain-chain.evil.example" },
    },
    {
      name: "a title with a bidi override gives way to host and path",
      url: "https://evil.example/x",
      title: "Release notes\u202e",
      expect: { label: "evil.example/x" },
    },
    {
      name: "a link that can't be read shows as written, whatever its title",
      url: "http://evil.example/x",
      title: "T0mSIlver/starbridge#123",
      expect: { label: "http://evil.example/x" },
    },
    {
      name: "a very long URL is clipped",
      url: `https://github.com.example/${"x/".repeat(1000)}`,
      expect: { label: `github.com.example/${"x/".repeat(10)}…` },
    },
  ];
  for (const c of linkCases) {
    const got = linkChip({ url: c.url, title: c.title }, c.project);
    if (JSON.stringify(got) !== JSON.stringify(c.expect))
      throw new Error(`links.json "${c.name}": linkChip gives ${JSON.stringify(got)}`);
  }
  const linksFile = {
    note: "linkChip({url, title}, project): a link chip's icon and text in every client (#971, #1577). No icon: the plain chip.",
    cases: linkCases,
  };

  // --- quota-alerts.json ---
  const custom = {
    ...DEFAULT_QUOTA_ALERTS,
    windows: { "claude/primary": [], "zai/primary": ["unused-headroom"], codex: ["low-50"] },
  } satisfies QuotaAlertSettings;
  const alertCases = [
    {
      name: "default: weekly runs out",
      settings: DEFAULT_QUOTA_ALERTS,
      alert: { provider: "claude", window: "secondary", kind: "runs-out" },
      windowMinutes: 10080,
    },
    {
      name: "default: 5-hour runs out is quiet",
      settings: DEFAULT_QUOTA_ALERTS,
      alert: { provider: "claude", window: "primary", kind: "runs-out" },
      windowMinutes: 300,
    },
    {
      name: "default: a day counts as short",
      settings: DEFAULT_QUOTA_ALERTS,
      alert: { provider: "gemini", window: "primary", kind: "runs-out" },
      windowMinutes: 1440,
    },
    {
      name: "default: unknown length counts as long",
      settings: DEFAULT_QUOTA_ALERTS,
      alert: { provider: "mistral", window: "credits", kind: "runs-out" },
      windowMinutes: null,
    },
    {
      name: "default: low is quiet",
      settings: DEFAULT_QUOTA_ALERTS,
      alert: { provider: "claude", window: "secondary", kind: "low", threshold: 20 },
      windowMinutes: 10080,
    },
    {
      name: "window off beats its length",
      settings: { ...custom, short: ["runs-out"] },
      alert: { provider: "claude", window: "primary", kind: "runs-out" },
      windowMinutes: 300,
    },
    {
      name: "window's own choice",
      settings: custom,
      alert: { provider: "zai", window: "primary", kind: "unused-headroom" },
      windowMinutes: 300,
    },
    {
      name: "window's own choice leaves out the default",
      settings: custom,
      alert: { provider: "zai", window: "primary", kind: "runs-out" },
      windowMinutes: 10080,
    },
    {
      name: "provider key covers its windows",
      settings: custom,
      alert: { provider: "codex", window: "secondary", kind: "low", threshold: 50 },
      windowMinutes: 10080,
    },
    {
      name: "50% picked: a window that skipped to 20% still notifies",
      settings: custom,
      alert: { provider: "codex", window: "secondary", kind: "low", threshold: 20 },
      windowMinutes: 10080,
    },
    {
      name: "20% picked: 50% is quiet",
      settings: { ...DEFAULT_QUOTA_ALERTS, long: ["low-20"] },
      alert: { provider: "claude", window: "secondary", kind: "low", threshold: 50 },
      windowMinutes: 10080,
    },
    {
      name: "20% picked: 20% notifies",
      settings: { ...DEFAULT_QUOTA_ALERTS, long: ["low-20"] },
      alert: { provider: "claude", window: "secondary", kind: "low", threshold: 20 },
      windowMinutes: 10080,
    },
  ].map((c) => ({
    ...c,
    expect: wantsQuotaAlert(
      c.settings as QuotaAlertSettings,
      c.alert as QuotaAlert,
      c.windowMinutes,
    ),
  }));
  // A provider's key, which settings moved from before #914 hold, splits into its windows' keys.
  const moved = {
    ...DEFAULT_QUOTA_ALERTS,
    windows: { codex: ["low-50"], "zai/primary": [] },
  } satisfies QuotaAlertSettings;
  const codexWindows = [
    { provider: "codex", window: "primary" },
    { provider: "codex", window: "secondary" },
    { provider: "zai", window: "primary" },
  ];
  const withCases = [
    {
      name: "a window's own choices",
      settings: DEFAULT_QUOTA_ALERTS,
      provider: "claude",
      window: "primary",
      picked: ["runs-out", "low-20"],
    },
    {
      name: "none picked: the window is off",
      settings: DEFAULT_QUOTA_ALERTS,
      provider: "claude",
      window: "primary",
      picked: [],
    },
    {
      name: "undefined: the window follows its length again",
      settings: moved,
      provider: "zai",
      window: "primary",
    },
    {
      name: "a provider's key goes to its other windows",
      settings: moved,
      provider: "codex",
      window: "primary",
      picked: ["runs-out"],
    },
  ].map((c) => ({
    ...c,
    all: codexWindows,
    expect: withWindowAlerts(
      c.settings,
      c.provider,
      c.window,
      codexWindows,
      c.picked as QuotaAlertChoice[] | undefined,
    ),
  }));
  const quotaAlertsFile = {
    note: "wantsQuotaAlert(settings, alert, windowMinutes) and withWindowAlerts(settings, provider, window, all, picked) (#914, #1904). labels: the alerts table's column names, in order.",
    defaults: DEFAULT_QUOTA_ALERTS,
    labels: QUOTA_ALERT_CHOICES.map((c) => [c, QUOTA_ALERT_LABELS[c]]),
    cases: alertCases,
    with: withCases,
  };

  // --- quotas.json ---
  // How every client reads a window on the Quotas tab (#1904). Times are UTC.
  const qNow = "2026-10-12T10:00:00Z";
  const qPace = (
    willLastToReset: boolean,
    runsOutAt: string | null,
    stage: Pace["stage"] = "ahead",
  ) => ({
    stage,
    expectedUsedPercent: 40,
    deltaPercent: 10,
    projectedUsedPercent: willLastToReset ? 90 : 130,
    willLastToReset,
    runsOutAt,
  });
  const stateCases = [
    { name: "on pace", pace: qPace(true, null, "on-track"), resetsAt: "2026-10-12T12:00:00Z" },
    {
      name: "headroom unused: the uploader raised the alert",
      pace: qPace(true, null, "behind"),
      unusedAlert: true,
      resetsAt: "2026-10-12T10:30:00Z",
    },
    {
      name: "behind without the alert is on pace",
      pace: qPace(true, null, "behind"),
      resetsAt: "2026-10-12T10:30:00Z",
    },
    {
      name: "will run out",
      pace: qPace(false, "2026-10-12T11:00:00Z"),
      resetsAt: "2026-10-12T12:00:00Z",
    },
    {
      name: "ran out",
      pace: qPace(false, "2026-10-12T09:00:00Z"),
      resetsAt: "2026-10-12T12:00:00Z",
    },
    {
      name: "ran out this very second",
      pace: qPace(false, qNow),
      resetsAt: "2026-10-12T12:00:00Z",
    },
    { name: "no pace yet", pace: null, resetsAt: "2026-10-12T12:00:00Z" },
    {
      name: "too early in the window",
      pace: qPace(true, null, "unknown"),
      resetsAt: "2026-10-12T12:00:00Z",
    },
    {
      name: "runs out with no time is too early to tell",
      pace: qPace(false, null),
      resetsAt: "2026-10-12T12:00:00Z",
    },
    {
      name: "the reset passed: window reset, whatever the pace",
      pace: qPace(false, "2026-10-12T09:00:00Z"),
      resetsAt: "2026-10-12T09:30:00Z",
    },
    { name: "the reset is now", pace: qPace(true, null, "on-track"), resetsAt: qNow },
    { name: "no reset time", pace: qPace(false, "2026-10-12T11:00:00Z"), resetsAt: null },
  ].map((c) => {
    const place = {
      course: quotaCourse(c.pace, c.unusedAlert ?? false),
      runsOutAt: c.pace?.runsOutAt ?? null,
      resetsAt: c.resetsAt,
    };
    const state = quotaState(place, new Date(qNow));
    return {
      ...c,
      unusedAlert: c.unusedAlert ?? false,
      expect: {
        course: place.course,
        state,
        word: QUOTA_STATE_WORDS[state],
        runningOut: quotaRunningOut(place, new Date(qNow)),
      },
    };
  });
  const out = qPace(false, "2026-10-12T11:00:00Z");
  const even = qPace(true, null, "on-track");
  // The uploader's order: claude (two machines, laptop's first), codex, zai, gemini, mistral.
  const arrangeWindows = [
    {
      id: "claude laptop 5-hour",
      provider: "claude",
      machine: "laptop",
      pace: even,
      resetsAt: "2026-10-12T12:00:00Z",
    },
    {
      id: "claude devbox 5-hour",
      provider: "claude",
      machine: "devbox",
      pace: even,
      resetsAt: "2026-10-12T12:00:00Z",
    },
    {
      id: "claude devbox Weekly",
      provider: "claude",
      machine: "devbox",
      pace: out,
      resetsAt: "2026-10-15T12:00:00Z",
    },
    { id: "codex Weekly", provider: "codex", pace: out, resetsAt: "2026-10-15T12:00:00Z" },
    { id: "zai 5-hour", provider: "zai", pace: even, resetsAt: "2026-10-12T12:00:00Z" },
    {
      id: "gemini Daily",
      provider: "gemini",
      pace: qPace(false, "2026-10-12T07:00:00Z"),
      resetsAt: "2026-10-12T09:00:00Z",
    },
    { id: "mistral Monthly", provider: "mistral", pace: out, resetsAt: "2026-10-30T00:00:00Z" },
  ];
  const arrangeCases = [
    {
      name: "running out first, then by provider in the uploader's order",
      order: [],
      hidden: ["mistral"],
      runningOutFirst: true,
    },
    {
      name: "running out first, then the order set",
      order: ["zai", "gemini"],
      hidden: ["mistral"],
      runningOutFirst: true,
    },
    {
      name: "the order set holds for every window when running out first is off",
      order: ["zai", "gemini"],
      hidden: ["mistral"],
      runningOutFirst: false,
    },
    {
      name: "a provider set in the order but absent is skipped",
      order: ["openai", "codex"],
      hidden: [],
      runningOutFirst: false,
    },
  ].map((c) => ({
    ...c,
    expect: arrangeQuotas(arrangeWindows, c, (w) => ({
      provider: w.provider,
      machine: w.machine,
      runningOut: quotaRunningOut(
        { course: quotaCourse(w.pace, false), runsOutAt: w.pace.runsOutAt, resetsAt: w.resetsAt },
        new Date(qNow),
      ),
    })).map((w) => w.id),
  }));
  const quotasFile = {
    note: 'How every client reads a quota window (#1904): quotaCourse(pace, unusedAlert), quotaState({course, runsOutAt, resetsAt}, now) and its QUOTA_STATE_WORDS, quotaRunningOut, and arrangeQuotas(windows, {order, hidden, runningOutFirst}) by machine name. Each client formats the time after "Ran out" and "Will run out".',
    now: qNow,
    words: QUOTA_STATE_WORDS,
    state: stateCases,
    arrange: { windows: arrangeWindows, cases: arrangeCases },
  };

  // --- schemas.json ---
  const sessionExtras = {
    sessionTitle: "Merge the CLI uploader (#12)",
    links: [
      { kind: "remote-control", url: "https://claude.ai/code/session_01UZCLSHk7GjaUdtNBsLAvvt" },
      {
        kind: "desktop",
        url: "claude://claude.ai/epitaxy/local_dbf54d69-f2ac-4a14-b298-d7bb6ecf0e3f",
      },
    ],
  };
  const withSource = (extra: object) => ({
    ...decisionBody,
    source: { ...decisionBody.source, ...extra },
  });
  // A 1x1 PNG.
  const pixel = {
    type: "image/png",
    width: 1,
    height: 1,
    key: toB64(seed(44)),
    hash: toB64(seed(45)),
    alt: "The settings screen, cropped",
  };
  const artifact = { url: "https://claude.ai/public/artifacts/0b3f0e7c", title: "Both mockups" };
  // Machines sign the directory head they know into every item (#362).
  const withHead = (body: object) => [
    {
      name: "with a directory head",
      body: { ...body, dir: { length: 4, head: "A".repeat(43) } },
      valid: true,
    },
    {
      name: "with a cut directory head",
      body: { ...body, dir: { length: 4, head: "A".repeat(42) } },
      valid: false,
    },
    {
      name: "with a device's directory head",
      body: { ...body, dir: { length: 4, head: "A".repeat(43), by: "phone" } },
      valid: true,
    },
    {
      name: "with a directory head by a bad id",
      body: { ...body, dir: { length: 4, head: "A".repeat(43), by: "a phone" } },
      valid: false,
    },
  ];
  const schemas = {
    note: "Bodies that must pass or fail schema validation. `read`, when set, is part of what a client reads: a value it only displays and does not know reads as the neutral case (null: absent), and an alert of an unknown kind is left out. `text` holds bodies as JSON text, for what a vector file cannot hold.",
    decision: [
      { name: "valid", body: decisionBody, valid: true },
      // Ids read the same whatever their shape (#1697): three words, or the random one before.
      {
        name: "an id of three words",
        body: { ...decisionBody, id: "d_amber-otter-lantern" },
        valid: true,
      },
      {
        name: "an id of 16 random characters, from before words",
        body: { ...decisionBody, id: "d_BAij3FNrohhuUYQ_" },
        valid: true,
      },
      {
        name: "an id of 64 characters",
        body: { ...decisionBody, id: "d".repeat(64) },
        valid: true,
      },
      {
        name: "an id of 65 characters",
        body: { ...decisionBody, id: "d".repeat(65) },
        valid: false,
      },
      { name: "an id with a space", body: { ...decisionBody, id: "d_amber otter" }, valid: false },
      ...withHead(decisionBody),
      {
        name: "with agent and machine kind",
        body: {
          ...decisionBody,
          agent: "codex",
          source: { ...decisionBody.source, machineKind: "laptop" },
        },
        valid: true,
      },
      { name: "from Pi", body: { ...decisionBody, agent: "pi" }, valid: true },
      {
        name: "an agent this client does not know",
        body: { ...decisionBody, agent: "aider" },
        valid: true,
      },
      {
        name: "an agent that is no name",
        body: { ...decisionBody, agent: "Aider 2!" },
        valid: false,
      },
      {
        name: "an unknown machine kind",
        body: { ...decisionBody, source: { ...decisionBody.source, machineKind: "phone" } },
        valid: true,
        read: { source: { machineKind: null } },
      },
      { name: "an agent that is null", body: { ...decisionBody, agent: null }, valid: false },
      {
        name: "a null under a field it does not know",
        body: { ...decisionBody, later: null },
        valid: true,
      },
      {
        name: "a machine kind that is no string",
        body: { ...decisionBody, source: { ...decisionBody.source, machineKind: 5 } },
        valid: false,
      },
      {
        name: "free text",
        body: { ...decisionBody, options: [], recommended: undefined },
        valid: true,
      },
      { name: "one option", body: { ...decisionBody, options: ["Yes"] }, valid: false },
      {
        name: "five options",
        body: { ...decisionBody, options: ["a", "b", "c", "d", "e"], recommended: "a" },
        valid: false,
      },
      {
        name: "recommended not an option",
        body: { ...decisionBody, recommended: "Maybe" },
        valid: false,
      },
      {
        name: "duplicate options",
        body: { ...decisionBody, options: ["Yes", "Yes"] },
        valid: false,
      },
      { name: "no recipients", body: { ...decisionBody, to: [] }, valid: false },
      // zod counts a string's length in code points, not UTF-16 units: an emoji is one (#1082).
      {
        name: "a question of 300 emoji",
        body: { ...decisionBody, question: "😀".repeat(300) },
        valid: true,
      },
      {
        name: "a question of 301 emoji",
        body: { ...decisionBody, question: "😀".repeat(301) },
        valid: false,
      },
      { name: "session title and links", body: withSource(sessionExtras), valid: true },
      {
        name: "session title too long",
        body: withSource({ sessionTitle: "t".repeat(201) }),
        valid: false,
      },
      {
        name: "unknown link kind",
        body: withSource({ links: [{ kind: "vscode", url: "https://claude.ai/code/session_1" }] }),
        valid: false,
      },
      {
        name: "link outside its kind's prefix",
        body: withSource({ links: [{ kind: "remote-control", url: "javascript:alert(1)" }] }),
        valid: false,
      },
      {
        name: "desktop link on https",
        body: withSource({ links: [{ kind: "desktop", url: "https://claude.ai/code/session_1" }] }),
        valid: false,
      },
      {
        name: "link with a space",
        body: withSource({ links: [{ kind: "web", url: "https://claude.ai/code/a b" }] }),
        valid: false,
      },
      {
        name: "images and links",
        body: { ...decisionBody, images: [pixel, { ...pixel, alt: undefined }], links: [artifact] },
        valid: true,
      },
      {
        name: "link without a title",
        body: { ...decisionBody, links: [{ url: artifact.url }] },
        valid: true,
      },
      {
        name: "svg image",
        body: { ...decisionBody, images: [{ ...pixel, type: "image/svg+xml" }] },
        valid: false,
      },
      {
        name: "five images",
        body: { ...decisionBody, images: Array(5).fill(pixel) },
        valid: false,
      },
      {
        name: "image of width 0",
        body: { ...decisionBody, images: [{ ...pixel, width: 0 }] },
        valid: false,
      },
      {
        name: "image key not 32 bytes",
        body: { ...decisionBody, images: [{ ...pixel, key: toB64(new Uint8Array(31)) }] },
        valid: false,
      },
      {
        name: "plain http link",
        body: { ...decisionBody, links: [{ url: "http://claude.ai/public/artifacts/0b3f0e7c" }] },
        valid: false,
      },
      {
        name: "script link",
        body: { ...decisionBody, links: [{ url: "javascript:alert(1)" }] },
        valid: false,
      },
      {
        name: "five links",
        body: { ...decisionBody, links: Array(5).fill(artifact) },
        valid: false,
      },
      {
        name: "empty link title",
        body: { ...decisionBody, links: [{ ...artifact, title: "" }] },
        valid: false,
      },
      {
        name: "answered in an artifact",
        body: {
          ...decisionBody,
          options: [],
          recommended: undefined,
          answerIn: artifact,
          links: [{ url: "https://github.com/T0mSIlver/starbridge/pull/86" }],
        },
        valid: true,
      },
      {
        name: "answered in an artifact, taking done",
        body: {
          ...decisionBody,
          options: [],
          recommended: undefined,
          answerIn: artifact,
          done: true,
        },
        valid: true,
      },
      { name: "done without answerIn", body: { ...decisionBody, done: true }, valid: false },
      {
        name: "answered in an artifact and with options",
        body: { ...decisionBody, answerIn: artifact },
        valid: false,
      },
      {
        name: "answered on a plain http page",
        body: {
          ...decisionBody,
          options: [],
          recommended: undefined,
          answerIn: { url: "http://example.com" },
        },
        valid: false,
      },
    ],
    answer: [
      { name: "choice", body: answerBody, valid: true },
      {
        name: "text",
        body: { ...answerBody, choice: undefined, text: "Only after 6pm" },
        valid: true,
      },
      { name: "both", body: { ...answerBody, text: "and text" }, valid: false },
      { name: "neither", body: { ...answerBody, choice: undefined }, valid: false },
      { name: "done", body: { ...answerBody, choice: undefined, done: true }, valid: true },
      { name: "choice and done", body: { ...answerBody, done: true }, valid: false },
      {
        name: "done false",
        body: { ...answerBody, choice: undefined, done: false },
        valid: false,
      },
      ...withHead(answerBody),
    ],
    permission: [
      { name: "valid", body: permissionBody, valid: true },
      ...withHead(permissionBody),
      {
        name: "no suggestions, no description",
        body: { ...permissionBody, suggestions: [], description: undefined },
        valid: true,
      },
      {
        name: "with session title and links",
        body: { ...permissionBody, source: { ...permissionBody.source, ...sessionExtras } },
        valid: true,
      },
      {
        name: "expires after 10 minutes",
        body: { ...permissionBody, expiresAt: T(10, 11) },
        valid: false,
      },
      {
        name: "expires before it is made",
        body: { ...permissionBody, expiresAt: T(9) },
        valid: false,
      },
      {
        name: "two suggestions for one scope",
        body: {
          ...permissionBody,
          suggestions: [permissionBody.suggestions[0], permissionBody.suggestions[0]],
        },
        valid: false,
      },
      {
        name: "a suggestion for this call only",
        body: {
          ...permissionBody,
          suggestions: [{ label: "Once", rule: "Bash(ls)", scope: "once" }],
        },
        valid: false,
      },
      {
        name: "summary too long",
        body: { ...permissionBody, summary: "s".repeat(201) },
        valid: false,
      },
      {
        name: "input too long",
        body: { ...permissionBody, input: "i".repeat(8001) },
        valid: false,
      },
      {
        name: "an agent this client does not know",
        body: { ...permissionBody, agent: "gemini" },
        valid: true,
      },
      { name: "an agent that is no name", body: { ...permissionBody, agent: "" }, valid: false },
      {
        name: "created at hour 25",
        body: { ...permissionBody, createdAt: "2026-10-04T25:00:00Z" },
        valid: false,
      },
      {
        name: "times at offset +19:00",
        body: {
          ...permissionBody,
          createdAt: "2026-10-05T05:00:00+19:00",
          expiresAt: "2026-10-05T05:05:00+19:00",
        },
        valid: true,
      },
    ],
    "permission-answer": [
      { name: "allow for the session", body: permissionAnswerBody, valid: true },
      {
        name: "deny with a message",
        body: {
          ...permissionAnswerBody,
          behavior: "deny",
          scope: "once",
          message: "Push to a branch instead",
        },
        valid: true,
      },
      {
        name: "deny for the session",
        body: { ...permissionAnswerBody, behavior: "deny" },
        valid: false,
      },
      {
        name: "allow with a message",
        body: { ...permissionAnswerBody, message: "ok" },
        valid: false,
      },
      { name: "unknown scope", body: { ...permissionAnswerBody, scope: "user" }, valid: false },
      {
        name: "a short input hash",
        body: { ...permissionAnswerBody, inputHash: permissionAnswerBody.inputHash.slice(0, 42) },
        valid: false,
      },
      ...withHead(permissionAnswerBody),
    ],
    settled: [
      { name: "by a device", body: settledBody, valid: true },
      ...withHead(settledBody),
      {
        name: "a device's deny on a permission",
        body: { ...settledBody, behavior: "deny" },
        valid: true,
      },
      // A behavior other than allow or deny is refused, not shown (#1144).
      {
        name: "a behavior that is neither allow nor deny",
        body: { ...settledBody, behavior: "ask" },
        valid: false,
      },
      // behavior comes only with a device's outcome, reason only with withdrawn (#1284).
      {
        name: "a behavior at the keyboard",
        body: { ...settledBody, outcome: "keyboard", device: undefined, behavior: "allow" },
        valid: false,
      },
      {
        name: "a reason on a device's outcome",
        body: { ...settledBody, reason: "Fixed it myself after rereading the logs" },
        valid: false,
      },
      {
        name: "at the keyboard",
        body: { ...settledBody, outcome: "keyboard", device: undefined },
        valid: true,
      },
      {
        name: "a withdrawn decision",
        body: { ...settledBody, itemId: "dec_1", outcome: "withdrawn", device: undefined },
        valid: true,
      },
      {
        name: "a withdrawn decision with its reason",
        body: {
          ...settledBody,
          itemId: "dec_1",
          outcome: "withdrawn",
          device: undefined,
          reason: "Fixed it myself after rereading the logs",
        },
        valid: true,
      },
      {
        name: "a reason over 120 characters",
        body: {
          ...settledBody,
          itemId: "dec_1",
          outcome: "withdrawn",
          device: undefined,
          reason: "x".repeat(121),
        },
        valid: false,
      },
      {
        name: "a reason on two lines",
        body: {
          ...settledBody,
          itemId: "dec_1",
          outcome: "withdrawn",
          device: undefined,
          reason: "Fixed it myself\nafter rereading the logs",
        },
        valid: false,
      },
      {
        name: "an empty reason",
        body: {
          ...settledBody,
          itemId: "dec_1",
          outcome: "withdrawn",
          device: undefined,
          reason: "",
        },
        valid: false,
      },
      {
        name: "a decision answered elsewhere",
        body: { ...settledBody, itemId: "dec_1", outcome: "elsewhere", device: undefined },
        valid: true,
      },
      {
        name: "no outcome",
        body: { ...settledBody, outcome: undefined, device: undefined },
        valid: true,
      },
      {
        name: "unknown outcome",
        body: { ...settledBody, outcome: "lost", device: undefined },
        valid: true,
        read: { outcome: null },
      },
      {
        name: "device without its outcome",
        body: { ...settledBody, outcome: "timeout" },
        valid: false,
      },
      {
        name: "device outcome without the device",
        body: { ...settledBody, device: undefined },
        valid: false,
      },
    ],
    run: [
      { name: "running with steps", body: runBody, valid: true },
      ...withHead(runBody),
      {
        name: "running, no progress",
        body: { ...runBody, progress: undefined },
        valid: true,
      },
      {
        name: "percent",
        body: { ...runBody, progress: { done: 42, total: 100, unit: "percent" } },
        valid: true,
      },
      {
        name: "failed",
        body: { ...runBody, at: T(10, 5), exit: { code: 1, at: T(10, 5) } },
        valid: true,
      },
      {
        name: "with session title and links",
        body: { ...runBody, source: { ...runBody.source, ...sessionExtras } },
        valid: true,
      },
      { name: "no reason", body: { ...runBody, reason: "" }, valid: false },
      { name: "title too long", body: { ...runBody, title: "t".repeat(101) }, valid: false },
      {
        name: "more done than total",
        body: { ...runBody, progress: { done: 8, total: 7, unit: "step" } },
        valid: false,
      },
      { name: "progress that is null", body: { ...runBody, progress: null }, valid: false },
      {
        name: "an unknown progress unit",
        body: { ...runBody, progress: { done: 3_000_000_000, total: 4_000_000_000, unit: "byte" } },
        valid: true,
        read: { progress: null },
      },
      {
        name: "a percent out of 50",
        body: { ...runBody, progress: { done: 10, total: 50, unit: "percent" } },
        valid: false,
      },
      {
        name: "exit code 256",
        body: { ...runBody, exit: { code: 256, at: T(10, 5) } },
        valid: false,
      },
      { name: "updated before it started", body: { ...runBody, at: T(9) }, valid: false },
    ],
    waiting: [
      { name: "waiting", body: waitingBody, valid: true },
      ...withHead(waitingBody),
      { name: "working", body: { ...waitingBody, state: "working" }, valid: true },
      {
        name: "an unknown state",
        body: { ...waitingBody, state: "blocked" },
        valid: true,
        read: { state: "working" },
      },
      { name: "no state", body: { ...waitingBody, state: undefined }, valid: false },
      { name: "a directory head that is null", body: { ...waitingBody, dir: null }, valid: false },
      { name: "no decision", body: { ...waitingBody, decisionId: undefined }, valid: false },
      { name: "no recipients", body: { ...waitingBody, to: [] }, valid: false },
    ],
    snooze: [
      { name: "valid", body: snoozeBody, valid: true },
      ...withHead(snoozeBody),
      { name: "back now", body: { ...snoozeBody, until: snoozeBody.at }, valid: true },
      { name: "no until", body: { ...snoozeBody, until: undefined }, valid: false },
      {
        name: "an until that is not a time",
        body: { ...snoozeBody, until: "18:00" },
        valid: false,
      },
      {
        name: "an until without seconds",
        body: { ...snoozeBody, until: "2026-10-04T18:00Z" },
        valid: false,
      },
      {
        name: "an until with an offset",
        body: { ...snoozeBody, until: "2026-10-04T20:00:00+02:00" },
        valid: true,
      },
      {
        name: "an offset without its colon",
        body: { ...snoozeBody, until: "2026-10-04T20:00:00+0200" },
        valid: false,
      },
      {
        name: "an until on February 30",
        body: { ...snoozeBody, until: "2026-02-30T18:00:00Z" },
        valid: false,
      },
      {
        name: "an until in month 13",
        body: { ...snoozeBody, until: "2026-13-01T18:00:00Z" },
        valid: false,
      },
      {
        name: "an until on a leap day",
        body: { ...snoozeBody, until: "2028-02-29T18:00:00Z" },
        valid: true,
      },
      {
        name: "an until at offset +19:00",
        body: { ...snoozeBody, until: "2026-10-05T13:00:00+19:00" },
        valid: true,
      },
      {
        name: "an until at offset +24:00",
        body: { ...snoozeBody, until: "2026-10-05T18:00:00+24:00" },
        valid: false,
      },
      { name: "no decision", body: { ...snoozeBody, decisionId: undefined }, valid: false },
      { name: "no recipients", body: { ...snoozeBody, to: [] }, valid: false },
      { name: "a directory head that is null", body: { ...snoozeBody, dir: null }, valid: false },
    ],
    quota: [
      { name: "valid", body: quotaBody, valid: true },
      {
        name: "an unknown pace stage",
        body: {
          ...quotaBody,
          providers: [
            { provider: "zai", windows: [{ ...win, pace: { ...pace, stage: "racing" } }] },
          ],
        },
        valid: true,
        read: { providers: [{ windows: [{ pace: { stage: "unknown" } }] }] },
      },
      {
        name: "an alert of an unknown kind is left out",
        body: {
          ...quotaBody,
          alerts: [
            { kind: "burst", share: 0.5, resetsAt: null },
            { kind: "low", provider: "zai", window: "primary", resetsAt: T(12, 30), threshold: 10 },
          ],
        },
        valid: true,
        read: {
          alerts: [
            { kind: "low", provider: "zai", window: "primary", resetsAt: T(12, 30), threshold: 10 },
          ],
        },
      },
      {
        name: "a window without its pace yet",
        body: { ...quotaBody, providers: [{ provider: "zai", windows: [{ ...win, pace: null }] }] },
        valid: true,
      },
      {
        name: "a pace without its stage",
        body: {
          ...quotaBody,
          providers: [
            { provider: "zai", windows: [{ ...win, pace: { ...pace, stage: undefined } }] },
          ],
        },
        valid: false,
      },
      {
        name: "another kind's field, null, on an alert",
        body: {
          ...quotaBody,
          alerts: [
            {
              kind: "low",
              provider: "zai",
              window: "primary",
              resetsAt: T(12, 30),
              threshold: 10,
              runsOutAt: null,
            },
          ],
        },
        valid: true,
      },
      { name: "no recipients", body: { ...quotaBody, to: [] }, valid: false },
      {
        name: "a window label over 100 characters",
        body: {
          ...quotaBody,
          providers: [{ provider: "zai", windows: [{ ...win, label: "l".repeat(101), pace }] }],
        },
        valid: false,
      },
      {
        name: "a provider read at no time",
        body: {
          ...quotaBody,
          providers: [{ provider: "zai", windows: [], error: "down", updatedAt: "yesterday" }],
        },
        valid: false,
      },
      {
        name: "an alert with notify false",
        body: {
          ...quotaBody,
          alerts: [
            {
              kind: "low",
              provider: "zai",
              window: "primary",
              resetsAt: T(12, 30),
              threshold: 10,
              notify: false,
            },
          ],
        },
        valid: false,
      },
    ],
    // Decision bodies as the JSON text a reader parses: Swift cannot read a lone surrogate, so it
    // must not be in a vector file (#1090). The `@` in the body becomes a `\u` escape.
    text: [
      ["a surrogate pair", { question: "Ship it @?" }, "\\ud83d\\ude80", true],
      ["a lone high surrogate", { question: "Ship it @?" }, "\\ud83d", false],
      ["a lone low surrogate in an option", { options: ["Yes @", "No"] }, "\\ude80", false],
      ["a pair in the wrong order", { question: "Ship it @?" }, "\\ude80\\ud83d", false],
      ["one in a field readers do not know", { note: "@" }, "\\ud800", false],
      ["one in a key", { extra: { "@": 1 } }, "\\udfff", false],
    ].map(([name, extra, esc, valid]) => ({
      name,
      kind: "decision",
      text: JSON.stringify({ ...decisionBody, ...(extra as object) }).replace("@", esc as string),
      valid,
    })),
  };

  // --- images.json ---
  // A 1x1 PNG sealed with a fixed key and nonce, so the blob comes out the same on every run.
  const png = fromB64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg",
  );
  const imageKey = seed(41);
  const nonce = new Uint8Array(sodium.crypto_secretbox_NONCEBYTES).fill(42);
  const blobBytes = concat(nonce, sodium.crypto_secretbox_easy(png, nonce, imageKey));
  const blobHash = (b: Uint8Array) =>
    toB64(
      sodium.crypto_generichash(
        32,
        concat(utf8("starbridge/v1/image"), new Uint8Array([0]), b),
        null,
      ),
    );
  const blob = toB64(blobBytes);
  const ref = { key: toB64(imageKey), hash: blobHash(blobBytes) };
  const flipped = blobBytes.slice();
  flipped[30] = (flipped[30] as number) ^ 1;
  const images = {
    description:
      "A decision image's blob: nonce then crypto_secretbox under ref.key; ref.hash is BLAKE2b-256 of 'starbridge/v1/image' NUL and the blob. openImage checks the hash, then opens.",
    cases: [
      { name: "opens", blob, ref, plain: toB64(png), expect: "ok" },
      { name: "a changed blob fails its hash", blob: toB64(flipped), ref, expect: "cannot-open" },
      {
        name: "a changed blob under its own hash fails its MAC",
        blob: toB64(flipped),
        ref: { ...ref, hash: blobHash(flipped) },
        expect: "cannot-open",
      },
      {
        name: "another key fails",
        blob,
        ref: { ...ref, key: toB64(seed(43)) },
        expect: "cannot-open",
      },
      { name: "a blob that is not base64url fails", blob: "A", ref, expect: "cannot-open" },
      {
        name: "a blob shorter than nonce and MAC fails",
        blob: toB64(nonce),
        ref: { ...ref, hash: blobHash(nonce) },
        expect: "cannot-open",
      },
    ],
  };

  // --- heads.json ---
  // The phone adds the stolen phone (phone2) and the dev box; truth: the phone revokes phone2,
  // which the server hides. Forks the server can make with phone2's keys revoke the dev box or the
  // phone instead; a recover ends every hold.
  const base: SignedEnvelope[] = [chain[0] as SignedEnvelope];
  const grow = (from: SignedEnvelope[], make: (d: Directory) => SignedEnvelope) => [
    ...from,
    make(verifyDirectory(from)),
  ];
  const b1 = grow(base, (d) => addEntry(d, signer(phone), phone2.member, T(11)));
  const stale = grow(b1, (d) => addEntry(d, signer(phone), devbox.member, T(11, 5)));
  const chains = {
    stale,
    truth: grow(stale, (d) => revokeEntry(d, signer(phone), "phone2", T(11, 10))),
    forkRevokesMachine: grow(stale, (d) => revokeEntry(d, signer(phone2), "devbox", T(11, 10))),
    forkRevokesBy: grow(stale, (d) => revokeEntry(d, signer(phone2), "phone", T(11, 10))),
    recovered: grow(stale, (d) => recoverEntry(d, recovery.privateKey, browser.member, T(11, 10))),
    revokedThenRecovered: grow(
      grow(stale, (d) => revokeEntry(d, signer(phone), "devbox", T(11, 10))),
      (d) => recoverEntry(d, recovery.privateKey, browser.member, T(11, 15)),
    ),
  };
  type ChainName = keyof typeof chains;
  const dirOf = (c: ChainName) => verifyDirectory(chains[c]);
  const H = { length: dirOf("truth").length, head: dirOf("truth").head };
  const forged = { length: 9, head: "A".repeat(43) };
  const withheldCase = (name: string, heads: Heads, c: ChainName) => ({
    name,
    heads,
    chain: c,
    expect: withheldBy(heads, dirOf(c), chains[c]) ?? null,
  });
  // A head kept before #1627 may carry `by`, which readers ignore: expectations list only what
  // each head says, so every client compares the same thing.
  const plain = (h: Heads): Heads =>
    Object.fromEntries(Object.entries(h).map(([k, v]) => [k, { length: v.length, head: v.head }]));
  const noteCase = (name: string, heads: Heads, signerId: string, head: object, c: ChainName) => {
    const after = structuredClone(heads);
    const changed = noteHead(after, signerId, head as never, chains[c]);
    return {
      name,
      heads,
      signer: signerId,
      head,
      chain: c,
      expect: { changed, heads: plain(after) },
    };
  };
  const forgetCase = (name: string, heads: Heads, id: string) => {
    const after = structuredClone(heads);
    forgetHeads(after, id);
    return { name, heads, id, expect: plain(after) };
  };
  // How heads were kept before #1627: under "signer/by", or "signer/?" for a by the chain did not list.
  const passedOn = { ...H, by: "phone" } as Heads[string];
  const unknownBy = { ...forged, by: "ghost" } as Heads[string];
  const heads = {
    note: 'withheldBy(heads, verifyDirectory(chains[chain]), chains[chain]); noteHead(heads, signer, head, chains[chain]); forgetHeads(heads, id). A `revoke` ends no hold (#813); a `recover` does. Heads kept before #1627 under "signer/by" or "signer/?" count as their signer\'s, and expected heads leave out their `by`; noteHead keeps no head that names a `by`.',
    chains,
    withheld: [
      withheldCase("a machine's head the chain lacks holds", { devbox: H }, "stale"),
      withheldCase("the chain that holds it does not", { devbox: H }, "truth"),
      withheldCase(
        "a fork that revokes the machine still holds, naming the revocation",
        { devbox: H },
        "forkRevokesMachine",
      ),
      withheldCase("a recover ends it", { devbox: H }, "recovered"),
      withheldCase(
        "a recover ends it for a member revoked before it",
        { devbox: forged },
        "revokedThenRecovered",
      ),
      withheldCase("a signer the chain does not list counts not", { ghost: H }, "stale"),
      withheldCase(
        "a head no revoke names comes first",
        { devbox: H, phone2: forged },
        "forkRevokesMachine",
      ),
      withheldCase(
        "a head kept under signer/by before #1627 holds as its signer's",
        { "devbox/phone": passedOn },
        "stale",
      ),
      withheldCase(
        "a head kept under signer/? before #1627 holds as its signer's",
        { "devbox/?": unknownBy },
        "stale",
      ),
      withheldCase(
        "a fork that revokes the by of a head kept before #1627 names no revocation",
        { "devbox/phone": passedOn },
        "forkRevokesBy",
      ),
      withheldCase(
        "a recover ends a head kept before #1627",
        { "devbox/phone": passedOn, "devbox/?": unknownBy },
        "recovered",
      ),
    ],
    noteHead: [
      noteCase("a first head is kept", {}, "devbox", H, "stale"),
      noteCase(
        "a shorter head does not replace one the chain lacks",
        { devbox: H },
        "devbox",
        {
          length: 2,
          head: dirOf("stale").head,
        },
        "stale",
      ),
      noteCase(
        "a head that names a by is not kept",
        {},
        "devbox",
        { ...H, by: "phone" },
        "forkRevokesBy",
      ),
      noteCase(
        "a longer head that names a by does not replace the signer's own the chain lacks",
        { devbox: H },
        "devbox",
        unknownBy,
        "stale",
      ),
      noteCase(
        "a signer whose id is __proto__ is kept like any other (#1977)",
        {},
        "__proto__",
        H,
        "stale",
      ),
      noteCase(
        "heads kept before #1627 stay beside the signer's",
        { "devbox/phone": passedOn, "devbox/?": unknownBy },
        "devbox",
        H,
        "stale",
      ),
    ],
    forgetHeads: [
      forgetCase(
        "drops every head the member signed, under any key",
        {
          devbox: H,
          "devbox/phone": passedOn,
          "devbox/?": unknownBy,
          phone2: forged,
        },
        "devbox",
      ),
      forgetCase(
        "drops a head kept before #1627 that a machine passed on from the member (#1730)",
        {
          devbox: H,
          "devbox/phone": passedOn,
          "devbox/?": unknownBy,
          "laptop/phone": { ...forged, by: "phone" } as Heads[string],
        },
        "phone",
      ),
    ],
  };

  // Rules each client applies on its own (#1429): the web, Android and iOS tests check theirs
  // against these, so a change to one fails the others' tests until they follow.
  const rules = {
    note: "Rules every client applies on its own (#1429). A time without a zone is the device's local time.",
    presence: {
      inputMs: PRESENCE_INPUT_MS,
      beatMs: PRESENCE_BEAT_MS,
      checkMs: 10_000,
      holdChoices: [...PUSH_HOLD_CHOICES],
    },
    retryForMs: 20_000,
    // Limits a client applies before the server would refuse (PROTOCOL.md, Limits).
    limits: { answerTextMax: ANSWER_TEXT_MAX, blobMax: BLOB_MAX, itemBytes: ITEM_BYTES },
    // The longest permission input a card's line holds, in UTF-16 units.
    rowInputMax: 200,
    snooze: {
      minMs: 5 * 60_000,
      maxMs: SNOOZE_MAX_MS,
      // The menu's fixed times: 1 hour, and This evening (18:00) until 17:00.
      presets: [
        {
          now: "2026-10-12T10:20",
          presets: [
            ["1 hour", "2026-10-12T11:20"],
            ["This evening", "2026-10-12T18:00"],
          ],
        },
        {
          now: "2026-10-12T16:59",
          presets: [
            ["1 hour", "2026-10-12T17:59"],
            ["This evening", "2026-10-12T18:00"],
          ],
        },
        { now: "2026-10-12T17:00", presets: [["1 hour", "2026-10-12T18:00"]] },
        { now: "2026-10-12T23:30", presets: [["1 hour", "2026-10-13T00:30"]] },
      ],
      // Whether a snooze may end at `until`: 5 minutes from now on, at most 7 days ahead.
      allowed: [
        { now: "2026-10-12T10:00", until: "2026-10-12T09:59", allowed: false },
        { now: "2026-10-12T10:00", until: "2026-10-12T10:04", allowed: false },
        { now: "2026-10-12T10:00", until: "2026-10-12T10:05", allowed: true },
        { now: "2026-10-12T10:00", until: "2026-10-19T10:00", allowed: true },
        { now: "2026-10-12T10:00", until: "2026-10-19T10:01", allowed: false },
      ],
      // The morning a swipe snoozes until: tomorrow at 9:00, or this morning before 5:00 (#692).
      morning: [
        { now: "2026-10-12T04:59", morning: "2026-10-12T09:00" },
        { now: "2026-10-12T05:00", morning: "2026-10-13T09:00" },
        { now: "2026-10-12T22:00", morning: "2026-10-13T09:00" },
      ],
    },
    // Which of two updates of one decision a client keeps, whichever arrives first (#2103):
    // `later` says whether `next` replaces `kept`. Times compare as instants, never as text.
    order: {
      snooze: [
        {
          name: "a later at wins",
          kept: { at: "2026-10-12T10:00:00Z", until: "2026-10-12T11:00:00Z" },
          next: { at: "2026-10-12T10:00:01Z", until: "2026-10-12T10:00:01Z" },
          later: true,
        },
        {
          name: "an earlier at loses",
          kept: { at: "2026-10-12T10:00:01Z", until: "2026-10-12T10:00:01Z" },
          next: { at: "2026-10-12T10:00:00.900Z", until: "2026-10-12T11:00:00Z" },
          later: false,
        },
        {
          name: "fractional seconds compare as instants",
          kept: { at: "2026-10-12T10:00:00Z", until: "2026-10-12T11:00:00Z" },
          next: { at: "2026-10-12T10:00:00.500Z", until: "2026-10-12T10:00:00.500Z" },
          later: true,
        },
        {
          name: "equal instants: the earlier until wins",
          kept: { at: "2026-10-12T10:00:00Z", until: "2026-10-12T11:00:00Z" },
          next: { at: "2026-10-12T10:00:00.000Z", until: "2026-10-12T10:00:00Z" },
          later: true,
        },
        {
          name: "equal instants: a later until loses",
          kept: { at: "2026-10-12T10:00:00Z", until: "2026-10-12T10:00:00Z" },
          next: { at: "2026-10-12T10:00:00Z", until: "2026-10-12T11:00:00Z" },
          later: false,
        },
        {
          name: "the same snooze again changes nothing",
          kept: { at: "2026-10-12T10:00:00Z", until: "2026-10-12T11:00:00Z" },
          next: { at: "2026-10-12T10:00:00Z", until: "2026-10-12T11:00:00Z" },
          later: false,
        },
        {
          name: "nothing kept",
          next: { at: "2026-10-12T10:00:00Z", until: "2026-10-12T11:00:00Z" },
          later: true,
        },
      ],
      waiting: [
        {
          name: "a later at wins",
          kept: { at: "2026-10-12T10:00:00Z", state: "waiting" },
          next: { at: "2026-10-12T10:00:01Z", state: "working" },
          later: true,
        },
        {
          name: "an earlier at loses",
          kept: { at: "2026-10-12T10:00:01Z", state: "working" },
          next: { at: "2026-10-12T10:00:00Z", state: "waiting" },
          later: false,
        },
        {
          name: "fractional seconds compare as instants",
          kept: { at: "2026-10-12T10:00:00Z", state: "waiting" },
          next: { at: "2026-10-12T10:00:00.500Z", state: "working" },
          later: true,
        },
        {
          name: "equal instants: waiting wins",
          kept: { at: "2026-10-12T10:00:00Z", state: "working" },
          next: { at: "2026-10-12T10:00:00Z", state: "waiting" },
          later: true,
        },
        {
          name: "equal instants: working loses",
          kept: { at: "2026-10-12T10:00:00Z", state: "waiting" },
          next: { at: "2026-10-12T10:00:00Z", state: "working" },
          later: false,
        },
        {
          name: "nothing kept",
          next: { at: "2026-10-12T10:00:00Z", state: "working" },
          later: true,
        },
      ],
      // The at a device stamps on a snooze it sends at `now`, `last` the latest one it knows:
      // past `last`, in whole seconds or milliseconds as the client stamps them.
      stamp: [
        {
          name: "no snooze known",
          now: "2026-10-12T10:00:00.400Z",
          seconds: "2026-10-12T10:00:00Z",
          millis: "2026-10-12T10:00:00.400Z",
        },
        {
          name: "an older one",
          now: "2026-10-12T10:00:05.400Z",
          last: "2026-10-12T10:00:00Z",
          seconds: "2026-10-12T10:00:05Z",
          millis: "2026-10-12T10:00:05.400Z",
        },
        {
          name: "one in the same second",
          now: "2026-10-12T10:00:00.700Z",
          last: "2026-10-12T10:00:00.300Z",
          seconds: "2026-10-12T10:00:01Z",
          millis: "2026-10-12T10:00:00.700Z",
        },
        {
          name: "one stamped ahead",
          now: "2026-10-12T10:00:00.700Z",
          last: "2026-10-12T10:00:01Z",
          seconds: "2026-10-12T10:00:02Z",
          millis: "2026-10-12T10:00:01.001Z",
        },
      ],
    },
    // What a push about one question may ring on a device, as it arrives late, twice or out of
    // order (#2151). Each case feeds its steps, in order, through the client's own push handler;
    // `rings` says whether that step sounds. `id` is always the question's: a waiting flip or a
    // snooze names it inside its own item. `restart` is the app or the service worker starting
    // again, so what a device must remember survives it.
    notify: notifyCases(),
    // A question's options, the agent's recommended one first (#191), compared by code points. A
    // question with options always names one.
    options: [
      {
        name: "recommended moves first",
        options: ["Merge", "Wait", "Close"],
        recommended: "Close",
        ordered: ["Close", "Merge", "Wait"],
      },
      {
        name: "recommended already first",
        options: ["Merge", "Wait", "Close"],
        recommended: "Merge",
        ordered: ["Merge", "Wait", "Close"],
      },
      {
        name: "composed and decomposed are two options",
        options: ["\u00e9", "e\u0301"],
        recommended: "e\u0301",
        ordered: ["e\u0301", "\u00e9"],
      },
    ],
  };

  return {
    "heads.json": heads,
    "images.json": images,
    "keys.json": keys,
    "directory.json": directory,
    "envelopes.json": envelopes,
    "pairing.json": pairing,
    "join.json": join,
    "pace.json": paceFile,
    "context.json": contextFile,
    "links.json": linksFile,
    "quota-alerts.json": quotaAlertsFile,
    "quotas.json": quotasFile,
    "schemas.json": schemas,
    "rules.json": rules,
  };
}

/** JSON text as written to disk; `undefined` fields drop out, as in any JSON encoder. */
export function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (import.meta.main) {
  const dir = new URL("../vectors/", import.meta.url);
  for (const [name, value] of Object.entries(await buildVectors())) {
    await Bun.write(new URL(name, dir), render(value));
  }
}

/** A push in a `notify` case; `id` is the question's. */
type NotifyPush =
  | { kind: "decision" | "answered"; id: string }
  | { kind: "waiting"; id: string; at: string; state: "waiting" | "working" }
  | { kind: "snooze"; id: string; at: string; until: string; due: boolean };
type NotifyStep = { push: NotifyPush; rings: boolean } | { restart: true };

/** The `notify` cases of rules.json (#2151). */
function notifyCases(): { name: string; steps: NotifyStep[] }[] {
  const asked: NotifyPush = { kind: "decision", id: "d1" };
  const answered: NotifyPush = { kind: "answered", id: "d1" };
  const flip = (at: string, state: "waiting" | "working"): NotifyPush => ({
    kind: "waiting",
    id: "d1",
    at: `2026-10-12T10:00:0${at}Z`,
    state,
  });
  const snooze = (due: boolean): NotifyPush => ({
    kind: "snooze",
    id: "d1",
    at: "2026-10-12T10:00:00Z",
    until: "2026-10-12T11:00:00Z",
    due,
  });
  return [
    {
      name: "a question rings once, pushed twice",
      steps: [
        { push: asked, rings: true },
        { push: asked, rings: false },
      ],
    },
    {
      name: "a question pushed after its answer stays silent",
      steps: [
        { push: answered, rings: false },
        { push: asked, rings: false },
      ],
    },
    {
      name: "an answer still counts after a restart",
      steps: [{ push: answered, rings: false }, { restart: true }, { push: asked, rings: false }],
    },
    {
      name: "a waiting flip after the answer stays silent",
      steps: [
        { push: asked, rings: true },
        { push: answered, rings: false },
        { push: flip("1", "waiting"), rings: false },
      ],
    },
    {
      name: "a snooze's return after the answer stays silent",
      steps: [
        { push: asked, rings: true },
        { push: snooze(false), rings: false },
        { push: answered, rings: false },
        { push: snooze(true), rings: false },
      ],
    },
    {
      name: "a snooze's return pushed twice rings once",
      steps: [
        { push: asked, rings: true },
        { push: snooze(false), rings: false },
        { push: snooze(true), rings: true },
        { restart: true },
        { push: snooze(true), rings: false },
      ],
    },
    {
      name: "the same waiting flip pushed twice rings once",
      steps: [
        { push: asked, rings: true },
        { push: flip("1", "waiting"), rings: true },
        { restart: true },
        { push: flip("1", "waiting"), rings: false },
      ],
    },
    {
      name: "an older flip after a newer one changes nothing",
      steps: [
        { push: asked, rings: true },
        { push: flip("2", "waiting"), rings: true },
        { push: flip("1", "working"), rings: false },
        { push: flip("3", "waiting"), rings: false },
      ],
    },
    {
      name: "a flip that comes before its question shows it",
      steps: [
        { push: flip("1", "working"), rings: true },
        { push: asked, rings: false },
      ],
    },
  ];
}
