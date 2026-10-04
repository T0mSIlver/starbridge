// Everything this browser does as a device: setup, pairing, recovery, reading and answering.
// Components import this module dynamically, so libsodium and the protocol code load after the
// first paint. Every read of the directory replays the chain against the pin kept in IndexedDB.
import {
  activeMembers,
  addEntry,
  addEntryAsync,
  checkJoined,
  type Decision,
  type Directory,
  DirectoryEntry,
  formatPairingCode,
  fromB64,
  genesisEntryAsync,
  claimHash as hashClaim,
  type Member,
  newClaimSecret,
  newPairingCode,
  openAsync,
  openPairingApproval,
  openPairingRequest,
  type PairingCode,
  ProtocolError,
  pairingApproval,
  pairingRequest,
  parsePairingCode,
  RECOVERY,
  ready,
  recoveryKeyPair,
  recoverySeedFromWords,
  recoveryWords,
  revokeEntryAsync,
  type SealedItem,
  type SignedEnvelope,
  sealAsync,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { ApiError, api, type Stored } from "./api";
import { generateDeviceKeys, sealOpener, signer } from "./crypto/keys";
import * as store from "./store";
import type { Device, InboxItem, PairingRequest, QuotaCardData, Reply } from "./types";

export { ApiError };

/** A device of a verified directory, signed in and bound to this browser's keys. */
export interface Ctx {
  account: string;
  device: store.DeviceRecord;
  dir: Directory;
  entries: SignedEnvelope[];
}

export type Boot =
  | { state: "signed-out" }
  | { state: "first-device"; account: string }
  /** The account has devices and this browser is not one of them (or lost its binding). */
  | { state: "join"; account: string; stale: boolean }
  | { state: "revoked"; account: string; name: string }
  /** The directory failed verification: the server, or someone holding it, broke the chain. */
  | { state: "broken"; account: string; error: string }
  | { state: "ready"; ctx: Ctx };

const now = () => new Date().toISOString();

function randomId(prefix: string): string {
  return prefix + toB64(crypto.getRandomValues(new Uint8Array(12)));
}

/** A default device name from the user agent, such as "Firefox on Mac". */
export function defaultName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Fetches the chain, replays it against the pin, and moves the pin forward. */
async function trusted(account: string): Promise<{ dir: Directory; entries: SignedEnvelope[] }> {
  const entries = await api.directory();
  const pin = await store.get("pin", account);
  const dir = verifyDirectory(entries, { account, ...(pin ? { pin } : {}) });
  await store.extendPin(account, { length: dir.length, head: dir.head });
  return { dir, entries };
}

export async function boot(): Promise<Boot> {
  await ready;
  let me: Awaited<ReturnType<typeof api.me>>;
  try {
    me = await api.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return { state: "signed-out" };
    throw e;
  }
  const { account } = me;
  await store.put("current", account);
  const device = await store.get("device", account);
  const entries = await api.directory();
  if (entries.length === 0) {
    // A browser that pinned a chain never accepts an empty one: that would be a rollback.
    if (await store.get("pin", account))
      return { state: "broken", account, error: "rollback: the server sent an empty directory" };
    // Keys saved before a genesis that never reached the server.
    if (device) await store.del("device", account);
    return { state: "first-device", account };
  }
  let verified: { dir: Directory; entries: SignedEnvelope[] };
  try {
    verified = await trusted(account);
  } catch (e) {
    return { state: "broken", account, error: e instanceof Error ? e.message : String(e) };
  }
  if (!device) return { state: "join", account, stale: false };
  const entry = verified.dir.members.get(device.id);
  if (!entry || entry.member.boxPk !== device.boxPk || entry.member.signPk !== device.signPk) {
    // Saved before a pairing or recovery that never completed.
    await store.del("device", account);
    return { state: "join", account, stale: false };
  }
  if (!entry.active) return { state: "revoked", account, name: device.name };
  if (me.member !== device.id) return { state: "join", account, stale: true };
  return { state: "ready", ctx: { account, device, ...verified } };
}

async function newDevice(account: string, name: string) {
  const keys = await generateDeviceKeys();
  const record: store.DeviceRecord = {
    account,
    id: randomId("w_"),
    name,
    boxPk: toB64(keys.boxPk),
    signPk: toB64(keys.signPk),
    keys: keys.stored,
  };
  const member: Member = {
    id: record.id,
    role: "device",
    name,
    boxPk: record.boxPk,
    signPk: record.signPk,
  };
  return { record, member };
}

/**
 * Makes this browser the account's first device and returns the recovery words, which exist
 * nowhere else once the caller drops them.
 */
export async function setUpFirstDevice(account: string, name: string): Promise<string[]> {
  await ready;
  const { record, member } = await newDevice(account, name);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const recovery = recoveryKeyPair(seed);
  try {
    const entry = await genesisEntryAsync({
      account,
      device: member,
      sign: signer(record.keys),
      recovery,
      at: now(),
    });
    const dir = verifyDirectory([entry], { account });
    await store.put("device", record, account);
    await api.append(entry);
    await store.extendPin(account, { length: dir.length, head: dir.head });
    return recoveryWords(seed).split(" ");
  } finally {
    seed.fill(0);
    recovery.privateKey.fill(0);
  }
}

/**
 * Adds this browser with the recovery words, when every device is lost. Entry 0's recovery
 * signature must check against the key the words make, so a server cannot serve a chain of its
 * own here.
 */
export async function recover(account: string, name: string, words: string): Promise<void> {
  await ready;
  const seed = recoverySeedFromWords(words);
  const recovery = recoveryKeyPair(seed);
  try {
    const entries = await api.directory();
    const dir = verifyDirectory(entries, { account, recoveryPk: toB64(recovery.publicKey) });
    const { record, member } = await newDevice(account, name);
    const entry = addEntry(dir, { id: RECOVERY, signKey: recovery.privateKey }, member, now());
    const next = verifyDirectory([...entries, entry], { account });
    await store.put("device", record, account);
    await api.append(entry);
    await store.extendPin(account, { length: next.length, head: next.head });
  } finally {
    seed.fill(0);
    recovery.privateKey.fill(0);
  }
}

/** Joining as a new device: the code to type on a device the account already has. */
export interface Join {
  code: string;
  /** Resolves once a device approved and the directory holds this browser's keys. */
  done: Promise<void>;
  cancel: () => void;
}

export async function startJoin(account: string, name: string): Promise<Join> {
  await ready;
  const code = newPairingCode();
  const { record, member } = await newDevice(account, name);
  const claim = newClaimSecret();
  const request = pairingRequest({ v: 1, rendezvous: code.rendezvous, ...member, at: now() }, code);
  await store.put("device", record, account);
  await api.requestPairing(request, hashClaim(claim));
  const abort = new AbortController();
  const done = (async () => {
    for (;;) {
      if (abort.signal.aborted) throw new Error("cancelled");
      const res = await api.pairingResult(code.rendezvous, claim, 25, abort.signal);
      if (res) return finishJoin(account, code, res.approval, member);
    }
  })();
  return { code: formatPairingCode(code), done, cancel: () => abort.abort() };
}

async function finishJoin(account: string, code: PairingCode, approval: unknown, me: Member) {
  const body = openPairingApproval(approval, code);
  if (body.account !== account) throw new ProtocolError("wrong-account", body.account);
  const entries = await api.directory();
  // The approval's length and head, under the code's MAC, pin a directory the server cannot fake.
  const dir = verifyDirectory(entries, { account, pin: { length: body.length, head: body.head } });
  checkJoined(dir, me);
  await store.extendPin(account, { length: dir.length, head: dir.head });
}

// --- As a device ----------------------------------------------------------------------------

/** This browser's device for the account, with a verified directory, if it is still active. */
export async function deviceContext(account: string): Promise<Ctx | undefined> {
  await ready;
  const device = await store.get("device", account);
  if (!device) return undefined;
  const verified = await trusted(account);
  const entry = verified.dir.members.get(device.id);
  if (!entry?.active || entry.member.signPk !== device.signPk) return undefined;
  return { account, device, ...verified };
}

async function refresh(ctx: Ctx): Promise<Ctx> {
  return { ...ctx, ...(await trusted(ctx.account)) };
}

const me = (ctx: Ctx) => ({
  id: ctx.device.id,
  sign: signer(ctx.device.keys),
  openSeal: sealOpener(ctx.device.keys, fromB64(ctx.device.boxPk)),
});

/** Appends an entry this device signed, after checking locally that the chain accepts it. */
async function append(ctx: Ctx, make: (dir: Directory) => Promise<SignedEnvelope>): Promise<Ctx> {
  let fresh = await refresh(ctx);
  for (let attempt = 0; ; attempt++) {
    const entry = await make(fresh.dir);
    const dir = verifyDirectory([...fresh.entries, entry], { account: ctx.account });
    try {
      await api.append(entry);
    } catch (e) {
      // Another device appended first: replay and sign again on top of it.
      if (e instanceof ApiError && e.code === "not-next" && attempt < 2) {
        fresh = await refresh(fresh);
        continue;
      }
      throw e;
    }
    await store.extendPin(ctx.account, { length: dir.length, head: dir.head });
    return { ...fresh, dir, entries: [...fresh.entries, entry] };
  }
}

export function devices(ctx: Ctx): Device[] {
  const addedAt = new Map<string, string>();
  for (const env of ctx.entries) {
    const body = DirectoryEntry.parse(JSON.parse(env.body));
    if (body.op === "add") addedAt.set(body.member.id, body.at);
  }
  return [...ctx.dir.members.values()].map(({ member, active }) => ({
    ...member,
    addedAt: addedAt.get(member.id) ?? "",
    status: active ? "active" : "revoked",
    self: member.id === ctx.device.id,
  }));
}

/** Fetches the request under the typed code and checks its MAC: the server cannot swap keys. */
export async function readPairing(codeText: string): Promise<PairingRequest> {
  await ready;
  const code = parsePairingCode(codeText);
  const { request } = await api.pairing(code.rendezvous);
  const body = openPairingRequest(request, code);
  return {
    code: formatPairingCode(code),
    role: body.role,
    id: body.id,
    name: body.name,
    boxPk: body.boxPk,
    signPk: body.signPk,
    at: body.at,
  };
}

export async function approvePairing(ctx: Ctx, req: PairingRequest): Promise<Ctx> {
  const code = parsePairingCode(req.code);
  const member: Member = {
    id: req.id,
    role: req.role,
    name: req.name,
    boxPk: req.boxPk,
    signPk: req.signPk,
  };
  const next = await append(ctx, (dir) => addEntryAsync(dir, me(ctx), member, now()));
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: code.rendezvous,
      account: ctx.account,
      length: next.dir.length,
      head: next.dir.head,
      approver: ctx.device.id,
    },
    code,
  );
  await api.approve(code.rendezvous, approval);
  return next;
}

export function revoke(ctx: Ctx, id: string): Promise<Ctx> {
  return append(ctx, (dir) => revokeEntryAsync(dir, me(ctx), id, now()));
}

// --- Decisions ------------------------------------------------------------------------------

export interface Inbox {
  items: InboxItem[];
  cursor?: string;
  /** Items that failed to open or verify, and why. */
  rejected: { id: string; error: string }[];
}

async function openDecision(ctx: Ctx, s: Stored, sent: store.SentAnswers): Promise<InboxItem> {
  const { signer: machine, body } = await openAsync(
    s.item as SealedItem & { kind: "decision" },
    me(ctx),
    ctx.dir,
  );
  const reply = sent[body.id];
  return {
    decision: body as Decision,
    machine,
    ...(s.answeredAt ? { answeredAt: s.answeredAt } : {}),
    ...(reply
      ? { reply: "choice" in reply ? { choice: reply.choice } : { text: reply.text } }
      : {}),
  };
}

/** Opens a decision a push carried (or named, when it did not fit). */
export async function openPushedDecision(ctx: Ctx, item: SealedItem): Promise<InboxItem> {
  const sent = (await store.get("answers", ctx.account)) ?? {};
  return openDecision(ctx, { item, cursor: "", receivedAt: "" }, sent);
}

/** Opens a quota snapshot a push carried. */
export async function openPushedQuota(ctx: Ctx, item: SealedItem) {
  return (await openAsync(item as SealedItem & { kind: "quota" }, me(ctx), ctx.dir)).body;
}

/** Reads decisions after `inbox.cursor` and merges them in: answered ones come back answered. */
export async function loadInbox(ctx: Ctx, inbox: Inbox = { items: [], rejected: [] }) {
  const sent = (await store.get("answers", ctx.account)) ?? {};
  const byId = new Map(inbox.items.map((i) => [i.decision.id, i]));
  const rejected = [...inbox.rejected];
  let cursor = inbox.cursor;
  for (;;) {
    const page = await api.items("decision", cursor);
    for (const s of page.items) {
      try {
        const item = await openDecision(ctx, s, sent);
        byId.set(item.decision.id, item);
      } catch (e) {
        // A revoked machine's old decisions no longer verify; nothing to show or warn about.
        if (e instanceof ProtocolError && e.code === "revoked-signer") continue;
        if (!rejected.some((r) => r.id === s.item.id))
          rejected.push({ id: s.item.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    cursor = page.cursor;
    if (page.items.length < 100) break;
  }
  return { items: [...byId.values()], cursor, rejected } satisfies Inbox;
}

/** Signs the answer and seals it to the machine that asked, which must still be active. */
export async function answer(ctx: Ctx, item: InboxItem, reply: Reply): Promise<string> {
  const fresh = await refresh(ctx);
  const machine = fresh.dir.members.get(item.machine.id);
  if (!machine?.active) throw new Error(`${item.machine.name} was revoked`);
  const answeredAt = now();
  const sealed = await sealAsync(
    "answer",
    {
      v: 1,
      id: randomId("a_"),
      decisionId: item.decision.id,
      to: machine.member.id,
      answeredAt,
      ...reply,
    },
    me(fresh),
    [machine.member],
  );
  const sent = (await store.get("answers", ctx.account)) ?? {};
  await api.post(sealed);
  sent[item.decision.id] = { ...reply, answeredAt };
  await store.put("answers", sent, ctx.account);
  return answeredAt;
}

// --- Quotas ---------------------------------------------------------------------------------

export interface Quotas {
  cards: QuotaCardData[];
  takenAt?: string;
  errors: { provider: string; machine: string; error: string }[];
  rejected: { id: string; error: string }[];
}

export async function loadQuotas(ctx: Ctx): Promise<Quotas> {
  const out: Quotas = { cards: [], errors: [], rejected: [] };
  const stored = await api.quota();
  const machines = activeMembers(ctx.dir, "machine").length;
  for (const s of stored) {
    let opened: Awaited<ReturnType<typeof openAsync<"quota">>>;
    try {
      opened = await openAsync(s.item as SealedItem & { kind: "quota" }, me(ctx), ctx.dir);
    } catch (e) {
      out.rejected.push({ id: s.item.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const { signer: machine, body } = opened;
    if (!out.takenAt || body.takenAt > out.takenAt) out.takenAt = body.takenAt;
    for (const p of body.providers) {
      if (p.error) out.errors.push({ provider: p.provider, machine: machine.name, error: p.error });
      for (const w of p.windows) {
        const alert = body.alerts.find((a) => a.provider === p.provider && a.window === w.id);
        out.cards.push({
          provider: p.provider,
          ...(machines > 1 ? { machine: machine.name } : {}),
          window: w,
          ...(alert ? { alert } : {}),
        });
      }
    }
  }
  return out;
}
