/**
 * Writes the JSON test vectors in ../vectors. Keys come from fixed seeds, so everything but the
 * sealed boxes (which use a fresh ephemeral key each run) comes out the same on every run.
 * Run: bun run vectors
 */
import {
  addEntry,
  alertsFor,
  approverKeys,
  bindMessage,
  claimHash,
  codeFromLink,
  computePace,
  DEFAULT_ALERT_RULE,
  type Directory,
  encodeCrockford,
  entryHash,
  formatPairingCode,
  genesisEntry,
  hashInput,
  joinApproval,
  joinCommitment,
  joinerKeys,
  joinRequest,
  type Member,
  type MemberKeys,
  memberKeysFromSeeds,
  pairingApproval,
  pairingKey,
  pairingLink,
  pairingRequest,
  parsePairingCode,
  publicKeys,
  RECOVERY,
  ready,
  recoveryKeyPair,
  recoveryWords,
  revokeEntry,
  type SealedItem,
  type SignedEnvelope,
  seal,
  sign,
  signatureMessage,
  toB64,
  verifyDirectory,
} from "../src/index";
import { sodium, utf8 } from "../src/sodium";

const seed = (n: number) => new Uint8Array(32).fill(n);
const ACCOUNT = "acct_tom";
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
  const recoverySeed = seed(7);
  const recovery = recoveryKeyPair(recoverySeed);
  const recoveryPk = toB64(recovery.publicKey);
  const rec = { id: RECOVERY, signKey: recovery.privateKey };

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
    recovery: { seed: toB64(recoverySeed), words: recoveryWords(recoverySeed), signPk: recoveryPk },
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
  extend((d) => addEntry(d, rec, phone2.member, T(9, 20)));
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
    recovery: recoveryKeyPair(seed(8)),
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
  });
  const pin = { length: 3, head: entryHash((chain[2] as SignedEnvelope).body) };
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
      expect: { error: "bad-genesis" },
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
    default: { action: "Wait for tonight", at: T(11) },
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
    ...(kind === "answer" ? { re: "dec_1" } : {}),
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
    parse: [
      { input: formatPairingCode(code).toLowerCase(), expect: formatPairingCode(code) },
      { input: "0123 4567 89ab cdef ghjk mnpq", expect: "0123-4567-89AB-CDEF-GHJK-MNPQ" },
      { input: "o1l1-I111-1111-1111-1111-1111", expect: "0111-1111-1111-1111-1111-1111" },
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
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg",
    alt: "The settings screen, cropped",
  };
  const artifact = { url: "https://claude.ai/public/artifacts/0b3f0e7c", title: "Both mockups" };
  const schemas = {
    note: "Bodies that must pass or fail schema validation.",
    decision: [
      { name: "valid", body: decisionBody, valid: true },
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
        name: "image data not base64url",
        body: { ...decisionBody, images: [{ ...pixel, data: "iVBO+w==" }] },
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
    ],
    permission: [
      { name: "valid", body: permissionBody, valid: true },
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
      { name: "unknown agent", body: { ...permissionBody, agent: "gemini" }, valid: false },
      {
        name: "created at hour 25",
        body: { ...permissionBody, createdAt: "2026-10-04T25:00:00Z" },
        valid: false,
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
    ],
    settled: [
      { name: "by a device", body: settledBody, valid: true },
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
        valid: false,
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
  };

  return {
    "keys.json": keys,
    "directory.json": directory,
    "envelopes.json": envelopes,
    "pairing.json": pairing,
    "join.json": join,
    "pace.json": paceFile,
    "schemas.json": schemas,
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
