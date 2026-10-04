/**
 * Writes the JSON test vectors in ../vectors. Keys come from fixed seeds, so everything but the
 * sealed boxes (which use a fresh ephemeral key each run) comes out the same on every run.
 * Run: bun run vectors
 */
import {
  addEntry,
  alertsFor,
  computePace,
  type Directory,
  encodeCrockford,
  entryHash,
  formatPairingCode,
  genesisEntry,
  type Member,
  type MemberKeys,
  memberKeysFromSeeds,
  pairingApproval,
  pairingKey,
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
      recoveryPk,
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
    recoveryPk: toB64(recoveryKeyPair(seed(8)).publicKey),
    at: T(9),
  });
  const fakeChain = [otherGenesis];
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
          recoveryPk,
          at: T(9),
        }),
      ],
      expect: { error: "bad-genesis" },
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
    parse: [
      { input: formatPairingCode(code).toLowerCase(), expect: formatPairingCode(code) },
      { input: "0123 4567 89ab cdef ghjk mnpq", expect: "0123-4567-89AB-CDEF-GHJK-MNPQ" },
      { input: "o1l1-I111-1111-1111-1111-1111", expect: "0111-1111-1111-1111-1111-1111" },
      { input: "0123-4567-89AB-CDEF-GHJK-MNPU", expect: "bad-encoding" },
      { input: "0123-4567", expect: "bad-encoding" },
    ],
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
      name: "weekly, 80% used, a day left: no alert",
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
    rule: { leadFraction: 0.2, minUnusedPercent: 25, unusedHeadroom: true, runsOut: true },
    cases: paceCases,
  };

  // --- schemas.json ---
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
  };

  return {
    "keys.json": keys,
    "directory.json": directory,
    "envelopes.json": envelopes,
    "pairing.json": pairing,
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
