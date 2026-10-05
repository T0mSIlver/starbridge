// Everything this browser does as a device: setup, pairing, recovery, reading and answering.
// Components import this module dynamically, so libsodium and the protocol code load after the
// first paint. Every read of the directory replays the chain against the pin kept in IndexedDB.
import {
  activeMembers,
  addEntry,
  addEntryAsync,
  approverKeys,
  bindMessage,
  checkJoined,
  codeFromLink,
  type Decision,
  type Directory,
  DirectoryEntry,
  entryHash,
  formatPairingCode,
  fromB64,
  genesisEntryAsync,
  claimHash as hashClaim,
  type JoinKeys,
  joinApproval,
  joinCommitment,
  joinerKeys,
  joinRequest,
  type Member,
  newClaimSecret,
  newJoinId,
  newJoinKeyPair,
  newPairingCode,
  openAsync,
  openJoinApproval,
  openJoinRequest,
  openPairingApproval,
  openPairingRequest,
  type PairingCode,
  type Permission,
  ProtocolError,
  pairingApproval,
  pairingLink,
  pairingRequest,
  parsePairingCode,
  RECOVERY,
  RecoveryKeyError,
  type RecoveryKeyReading,
  readRecoveryKey,
  ready,
  recoveryKey,
  recoveryKeyPair,
  recoverySeedFromKey,
  revokeEntryAsync,
  type SealedItem,
  type Settled,
  type SignedEnvelope,
  sealAsync,
  toB64,
  verifyDirectory,
  type Waiting,
} from "@starbridge/protocol";
import { ApiError, api, type Stored } from "./api";
import { generateDeviceKeys, sealOpener, signer } from "./crypto/keys";
import * as store from "./store";
import type {
  Device,
  InboxItem,
  JoinAsk,
  JoinView,
  PairingRequest,
  PromptItem,
  PromptReply,
  QuotaCardData,
  Reply,
  RunItem,
} from "./types";

export { ApiError };

/** A device of a verified directory, signed in and bound to this browser's keys. */
export interface Ctx {
  account: string;
  device: store.DeviceRecord;
  dir: Directory;
  entries: SignedEnvelope[];
}

export type Boot =
  /** `known`: this browser holds a device of the account it last signed in to. */
  | { state: "signed-out"; known: boolean }
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

/** Moves the pin to a verified chain; refuses one that does not extend the stored pin. */
function pinTo(account: string, entries: SignedEnvelope[], dir: Directory): Promise<void> {
  return store.extendPin(account, { length: dir.length, head: dir.head }, (n) => {
    const e = entries[n - 1];
    return e ? entryHash(e.body) : undefined;
  });
}

/** Fetches the chain, replays it against the pin, and moves the pin forward. */
async function trusted(account: string): Promise<{ dir: Directory; entries: SignedEnvelope[] }> {
  for (let attempt = 0; ; attempt++) {
    const entries = await api.directory();
    const pin = await store.get("pin", account);
    const dir = verifyDirectory(entries, { account, ...(pin ? { pin } : {}) });
    try {
      await pinTo(account, entries, dir);
      return { dir, entries };
    } catch (e) {
      // The service worker or another tab pinned a longer chain meanwhile: read it again.
      if (e instanceof store.StalePin && attempt < 2) continue;
      throw e;
    }
  }
}

export async function boot(): Promise<Boot> {
  let me: Awaited<ReturnType<typeof api.me>>;
  try {
    me = await api.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      const last = await store.get("current");
      // Its device was revoked: this browser is a visitor again, not a device signing back in.
      if (last && e.code === "revoked") await store.del("device", last);
      return { state: "signed-out", known: !!last && !!(await store.get("device", last)) };
    }
    throw e;
  }
  await ready;
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
  if (me.member === null && !(await bind(account, device))) {
    return { state: "join", account, stale: true };
  } else if (me.member !== null && me.member !== device.id) {
    return { state: "join", account, stale: true };
  }
  return { state: "ready", ctx: { account, device, ...verified } };
}

/**
 * Signed in again: proves this browser holds the device's key, so the session becomes its own.
 * Another tab may bind the same session meanwhile, so a failure checks /me before retrying.
 */
async function bind(account: string, device: store.DeviceRecord): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const nonce = await api.challenge();
      const sig = await signer(device.keys)(bindMessage(account, device.id, nonce));
      await api.bind(device.id, toB64(sig));
      return true;
    } catch {
      if ((await api.me()).member === device.id) return true;
    }
  }
  return false;
}

async function newDevice(account: string, name: string) {
  const keys = await generateDeviceKeys(store.keeps);
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

/** A first device whose keys, genesis entry and recovery words exist, not yet on the server. */
export interface FirstDevice {
  recoveryKey: string;
  /** Posts the genesis; safe to call again after a failure, with the same keys and entry. */
  commit: () => Promise<void>;
}

/**
 * Makes this browser's keys and the account's genesis entry. The recovery seed is dropped once
 * the words exist, so the caller keeps this object until `commit` succeeds and the words are
 * shown; a retry reuses it rather than making new keys.
 */
export async function prepareFirstDevice(account: string, name: string): Promise<FirstDevice> {
  await ready;
  const { record, member } = await newDevice(account, name);
  const seed = crypto.getRandomValues(new Uint8Array(16));
  const recovery = recoveryKeyPair(seed);
  let entry: SignedEnvelope;
  let shown: string;
  try {
    entry = await genesisEntryAsync({
      account,
      device: member,
      sign: signer(record.keys),
      recovery,
      at: now(),
    });
    shown = recoveryKey(seed);
  } finally {
    seed.fill(0);
    recovery.privateKey.fill(0);
  }
  const dir = verifyDirectory([entry], { account });
  await store.put("device", record, account);
  const commit = async () => {
    try {
      await api.append(entry);
    } catch (e) {
      // The genesis may have landed with its response lost: it is ours if entry 0 is this one.
      const entries = await api.directory();
      if (entries[0]?.sig !== entry.sig) throw e;
    }
    await pinTo(account, [entry], dir);
  };
  return { recoveryKey: shown, commit };
}

/**
 * Adds this browser with the recovery words, when every device is lost. Entry 0's recovery
 * signature must check against the key the words make, so a server cannot serve a chain of its
 * own here.
 */
export async function recover(account: string, name: string, typed: string): Promise<void> {
  await ready;
  let seed: Uint8Array;
  try {
    seed = recoverySeedFromKey(typed);
  } catch (e) {
    throw e instanceof RecoveryKeyError ? new Error(problemText(e.reading) ?? e.message) : e;
  }
  const recovery = recoveryKeyPair(seed);
  try {
    // Keys first: the pin is read after the last await before signing, so a pin another tab
    // or the service worker moved meanwhile still counts.
    const { record, member } = await newDevice(account, name);
    const entries = await api.directory();
    // A browser that pinned this account before must not sign onto an older prefix.
    const pin = await store.get("pin", account);
    let dir: Directory;
    try {
      dir = verifyDirectory(entries, {
        account,
        recoveryPk: toB64(recovery.publicKey),
        ...(pin ? { pin } : {}),
      });
    } catch (e) {
      if (e instanceof ProtocolError && e.message === "bad-genesis: recovery key differs")
        throw new Error("This is a recovery key, but not this account's.");
      throw e;
    }
    const entry = addEntry(dir, { id: RECOVERY, signKey: recovery.privateKey }, member, now());
    const next = verifyDirectory([...entries, entry], { account });
    await store.put("device", record, account);
    await api.append(entry);
    await pinTo(account, [...entries, entry], next);
  } finally {
    seed.fill(0);
    recovery.privateKey.fill(0);
  }
}

/** What the recovery entry shows while typing: a problem, else how far along it is. */
export interface RecoveryEntry {
  complete: boolean;
  status: string;
  problem?: string;
}

export function readRecoveryEntry(text: string): RecoveryEntry {
  const reading = readRecoveryKey(text, { typing: true });
  const problem = problemText(reading);
  if (problem) return { complete: false, status: "", problem };
  if (reading.format === "words") {
    const of = reading.count > 12 ? 24 : 12;
    return {
      complete: reading.count === 12 || reading.count === 24,
      status: `${reading.count} of ${of} words`,
    };
  }
  return { complete: reading.count === 28, status: `${reading.count} of 28 characters` };
}

function problemText({ format, problem }: RecoveryKeyReading): string | undefined {
  switch (problem?.kind) {
    case undefined:
      return undefined;
    case "bad-character":
      return `Character ${problem.index + 1}, "${problem.char}", is not in a recovery key.`;
    case "length":
      return `A recovery key has 28 characters; this has ${problem.count}.`;
    case "unknown-word":
      return `Word ${problem.index + 1}, "${problem.word}", is not on the word list.`;
    case "word-count":
      return `Older accounts recover with 12 or 24 words; this has ${problem.count}.`;
    case "checksum":
      return format === "key"
        ? "A character is wrong. Check each group against what you wrote down."
        : "One word is wrong, or two are swapped. Check each word and the order.";
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
  await pinTo(account, entries, dir);
}

/** Joining by digits: no code to type; the owner compares 6 digits on both devices. */
export interface DigitJoin {
  /** Resolves once a device took the request: the digits it shows too. */
  digits: Promise<string>;
  /** Resolves once that device approved and the directory holds this browser's keys. */
  done: Promise<void>;
  cancel: () => void;
}

export async function startDigitJoin(account: string, name: string): Promise<DigitJoin> {
  await ready;
  const { record, member } = await newDevice(account, name);
  const eph = newJoinKeyPair();
  const id = newJoinId();
  const { role: _, ...keys } = member;
  const request = joinRequest({ v: 1, join: id, account, ...keys, at: now() });
  await store.put("device", record, account);
  const { expiresAt } = (await api.postJoin(request, joinCommitment(eph.publicKey, request))).join;
  const abort = new AbortController();
  let shown: (digits: string) => void = () => {};
  const digits = new Promise<string>((resolve) => {
    shown = resolve;
  });
  const done = (async () => {
    let derived: JoinKeys | undefined;
    let after = 0;
    try {
      for (;;) {
        if (abort.signal.aborted) throw new Error("cancelled");
        const { join } = await retrying(expiresAt, abort.signal, () =>
          api.join(id, after, 25, abort.signal),
        );
        after = join.version;
        if (join.state === "cancelled") throw new Error("The request was refused. Ask again.");
        // The first approver key is the only one: the digits commit to it, so a second one the
        // server offers later is never answered.
        if (!derived && join.approverKey)
          derived = joinerKeys({ mine: eph, approverKey: join.approverKey, request });
        if (derived && !join.joinerKey) {
          // A reveal whose answer was lost landed all the same.
          await retrying(expiresAt, abort.signal, () =>
            api.revealJoin(id, toB64(eph.publicKey)).catch((e) => {
              if (!(e instanceof ApiError && e.code === "already-revealed")) throw e;
            }),
          );
          shown(derived.digits);
        }
        if (derived && join.approval !== undefined) {
          const body = openJoinApproval(join.approval, derived, id);
          if (body.account !== account) throw new ProtocolError("wrong-account", body.account);
          const entries = await api.directory();
          const dir = verifyDirectory(entries, {
            account,
            pin: { length: body.length, head: body.head },
          });
          checkJoined(dir, member);
          await pinTo(account, entries, dir);
          return;
        }
      }
    } finally {
      eph.privateKey.fill(0);
    }
  })();
  return {
    digits,
    done,
    cancel: () => {
      abort.abort();
      api.cancelJoin(id).catch(() => {});
    },
  };
}

/**
 * Runs a join call again after a network or server failure, until the join expires or `signal`
 * aborts. Giving up would drop the ephemeral key, and the server takes one key per side.
 */
async function retrying<T>(
  expiresAt: string,
  signal: AbortSignal,
  call: () => Promise<T>,
): Promise<T> {
  for (;;) {
    try {
      return await call();
    } catch (e) {
      const transient = !(e instanceof ApiError) || e.status >= 500 || e.status === 429;
      if (signal.aborted || !transient) throw e;
      if (Date.parse(expiresAt) < Date.now()) throw new Error("The request expired.");
      await new Promise((r) => setTimeout(r, retryDelay.ms));
    }
  }
}

/** How long a failed join call waits before its next try; tests shorten it. */
export const retryDelay = { ms: 3_000 };

function toAsk(view: JoinView): JoinAsk | undefined {
  try {
    const body = openJoinRequest(view.request);
    return {
      id: view.id,
      name: body.name,
      at: body.at,
      ...(view.approver ? { approver: view.approver } : {}),
      view,
    };
  } catch {
    return undefined;
  }
}

/** Calls `onChange` with the account's open join requests until `signal` aborts. */
export async function watchJoins(signal: AbortSignal, onChange: (asks: JoinAsk[]) => void) {
  await ready;
  let cursor = "0";
  while (!signal.aborted) {
    try {
      const page = await api.joins(cursor, 25, signal);
      cursor = page.cursor;
      onChange(page.joins.flatMap((v) => toAsk(v) ?? []));
    } catch {
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

/** Digits this device derived for a join request, and what approving it does. */
export interface Comparison {
  digits: string;
  approve: (ctx: Ctx) => Promise<Ctx>;
}

/**
 * Takes the request as listed: posts this device's key, waits for the joining device to reveal
 * its key, and checks the reveal against the commitment listed before this key went out.
 */
export async function compareJoin(
  ctx: Ctx,
  ask: JoinAsk,
  signal: AbortSignal,
): Promise<Comparison> {
  await ready;
  const { request, commitment } = ask.view;
  const body = openJoinRequest(request);
  if (body.account !== ctx.account) throw new ProtocolError("wrong-account", body.account);
  if (body.join !== ask.id) throw new ProtocolError("id-mismatch", "join");
  const eph = newJoinKeyPair();
  const claimed = (await api.claimJoin(ask.id, toB64(eph.publicKey), ctx.device.id)).join;
  let after = claimed.version - 1;
  let keys: JoinKeys;
  try {
    for (;;) {
      const { join } = await retrying(claimed.expiresAt, signal, () =>
        api.join(ask.id, after, 25, signal),
      );
      after = join.version;
      if (join.state === "cancelled") throw new Error(`${body.name} cancelled the request.`);
      if (join.joinerKey) {
        keys = approverKeys({ mine: eph, joinerKey: join.joinerKey, request, commitment });
        break;
      }
      if (Date.parse(join.expiresAt) < Date.now()) throw new Error("The request expired.");
    }
  } finally {
    eph.privateKey.fill(0);
  }
  const member: Member = {
    id: body.id,
    role: "device",
    name: body.name,
    boxPk: body.boxPk,
    signPk: body.signPk,
  };
  return {
    digits: keys.digits,
    approve: async (current) => {
      const next = await appendMember(current, member);
      const approval = joinApproval(
        {
          v: 1,
          join: ask.id,
          account: current.account,
          length: next.dir.length,
          head: next.dir.head,
          approver: current.device.id,
        },
        keys,
      );
      await api.approveJoin(ask.id, approval);
      return next;
    },
  };
}

export function refuseJoin(id: string): Promise<void> {
  return api.cancelJoin(id);
}

/** A code this device shows as a QR, for a new phone to scan; the phone posts under it. */
export interface ShownCode {
  code: string;
  link: string;
  /** Resolves with the request once the phone posted it and its MAC checked out. */
  request: Promise<PairingRequest>;
  cancel: () => void;
}

export async function showPairingCode(): Promise<ShownCode> {
  await ready;
  const code = newPairingCode();
  const abort = new AbortController();
  const until = Date.now() + 10 * 60_000;
  const request = (async () => {
    for (;;) {
      if (abort.signal.aborted) throw new Error("cancelled");
      if (Date.now() > until) throw new Error("The code expired. Show a new one.");
      const res = await api.awaitPairing(code.rendezvous, 25, abort.signal);
      if (res) return readRequest(code, res.request);
    }
  })();
  return {
    code: formatPairingCode(code),
    link: pairingLink(location.origin, code),
    request,
    cancel: () => abort.abort(),
  };
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
    const entries = [...fresh.entries, entry];
    try {
      await pinTo(ctx.account, entries, dir);
    } catch (e) {
      // The entry is on the server and a longer chain was pinned meanwhile: carry on from it,
      // so the caller (an approval) still finishes.
      if (e instanceof store.StalePin) return refresh(fresh);
      throw e;
    }
    return { ...fresh, dir, entries };
  }
}

/**
 * Adds a member to approve, unless the directory already holds it with these keys: an approval
 * retried after its post failed reuses the entry the first try appended.
 */
async function appendMember(ctx: Ctx, member: Member): Promise<Ctx> {
  const fresh = await refresh(ctx);
  const held = fresh.dir.members.get(member.id);
  if (
    held?.active &&
    held.member.role === member.role &&
    held.member.boxPk === member.boxPk &&
    held.member.signPk === member.signPk
  )
    return fresh;
  return append(fresh, (dir) => addEntryAsync(dir, me(fresh), member, now()));
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
  const code = codeFromLink(codeText);
  const { request } = await api.pairing(code.rendezvous);
  return readRequest(code, request);
}

function readRequest(code: PairingCode, request: unknown): PairingRequest {
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
  const next = await appendMember(ctx, member);
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
  /**
   * Items signed by a member this directory does not hold yet: one paired after the last
   * read. They are tried again on the next load, after the directory is read again.
   */
  retry?: Stored[];
  /** The latest waiting state each machine posted, by `<machine>/<decision id>` (#122). */
  waits?: Record<string, Pick<Waiting, "state" | "at">>;
}

/** The server picks what it lists: an item of another kind is refused before it is opened. */
function expectKind<K extends SealedItem["kind"]>(item: SealedItem, kind: K) {
  if (item.kind !== kind)
    throw new ProtocolError("wrong-kind", `${item.kind} where ${kind} was due`);
  return item as SealedItem & { kind: K };
}

/** How each item a settled notice closed was closed, by item id, with the time it closed. */
type Closings = Map<string, { outcome: Settled["outcome"]; at: string }>;

async function openDecision(
  ctx: Ctx,
  s: Stored,
  sent: store.SentAnswers,
  closings: Closings = new Map(),
): Promise<InboxItem> {
  expectKind(s.item, "decision");
  const { signer: machine, body } = await openAsync(
    s.item as SealedItem & { kind: "decision" },
    me(ctx),
    ctx.dir,
  );
  const reply = sent[body.id];
  // The notice that closed it arrived in the same write, so it carries the same time; a later
  // one, after a device's answer, closed nothing.
  const closing = closings.get(body.id);
  const settled = closing && closing.at === s.answeredAt ? closing.outcome : undefined;
  return {
    decision: body as Decision,
    machine,
    ...(s.answeredAt ? { answeredAt: s.answeredAt } : {}),
    ...(settled ? { settled } : {}),
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

/**
 * Reads the directory again and checks this device is still in it; undefined once revoked. Run
 * before each load, so items from members paired elsewhere since boot verify.
 */
export async function reverify(ctx: Ctx): Promise<Ctx | undefined> {
  const fresh = await refresh(ctx);
  const self = fresh.dir.members.get(ctx.device.id);
  return self?.active ? fresh : undefined;
}

/** Reads decisions after `inbox.cursor` and merges them in: answered ones come back answered. */
export async function loadInbox(ctx: Ctx, inbox: Inbox = { items: [], rejected: [] }) {
  const sent = (await store.get("answers", ctx.account)) ?? {};
  // Decisions opened before a machine was revoked no longer verify: drop them.
  const byId = new Map(
    inbox.items
      .filter((i) => ctx.dir.members.get(i.machine.id)?.active)
      .map((i) => [i.decision.id, i]),
  );
  const rejected = [...inbox.rejected];
  const retry: Stored[] = [];
  // A settled notice lists before the decision it closed, which moved past it.
  const closings: Closings = new Map();
  const waits = { ...inbox.waits };
  const take = async (s: Stored, again: boolean) => {
    if (s.item.kind === "waiting") {
      // Only tells whether the agent waits: one that fails to open costs that and nothing else.
      try {
        const { signer, body } = await openAsync(expectKind(s.item, "waiting"), me(ctx), ctx.dir);
        const w = body as Waiting;
        const key = `${signer.id}/${w.decisionId}`;
        const had = waits[key];
        if (!had || had.at < w.at) waits[key] = { state: w.state, at: w.at };
      } catch {}
      return;
    }
    if (s.item.kind === "settled") {
      // Only tells how a decision closed: one that fails to open costs that and nothing else.
      try {
        const { body } = await openAsync(expectKind(s.item, "settled"), me(ctx), ctx.dir);
        closings.set(body.itemId, { outcome: body.outcome, at: s.receivedAt });
      } catch {}
      return;
    }
    try {
      const item = await openDecision(ctx, s, sent, closings);
      byId.set(item.decision.id, item);
    } catch (e) {
      // A revoked machine's old decisions no longer verify; nothing to show or warn about.
      if (e instanceof ProtocolError && e.code === "revoked-signer") return;
      if (e instanceof ProtocolError && e.code === "unknown-signer" && !again) {
        retry.push(s);
        return;
      }
      if (!rejected.some((r) => r.id === s.item.id))
        rejected.push({ id: s.item.id, error: e instanceof Error ? e.message : String(e) });
    }
  };
  for (const s of inbox.retry ?? []) await take(s, true);
  let cursor = inbox.cursor;
  for (;;) {
    const page = await api.items("decision,settled,waiting", cursor);
    for (const s of page.items) await take(s, false);
    cursor = page.cursor;
    if (page.items.length < 100) break;
  }
  // Only the machine that asked can say its agent waits on the question.
  const items = [...byId.values()].map((i) => {
    const w = waits[`${i.machine.id}/${i.decision.id}`];
    const { waitingSince: _, ...rest } = i;
    return w?.state === "waiting" ? { ...rest, waitingSince: w.at } : rest;
  });
  return { items, cursor, rejected, retry, waits } satisfies Inbox;
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
  await api.post(sealed);
  // The page and the service worker may both answer: merge into the record, never overwrite it.
  await store.update("answers", ctx.account, (sent) => ({
    ...sent,
    [item.decision.id]: { ...reply, answeredAt },
  }));
  return answeredAt;
}

// --- Permission prompts -------------------------------------------------------------------

async function openPermission(
  ctx: Ctx,
  s: Stored,
  sent: Record<string, PromptReply & { answeredAt: string }>,
): Promise<PromptItem> {
  const { signer: machine, body } = await openAsync(
    expectKind(s.item, "permission"),
    me(ctx),
    ctx.dir,
  );
  const reply = sent[body.id];
  return {
    permission: body as Permission,
    machine,
    receivedAt: s.receivedAt,
    ...(s.answeredAt ? { answeredAt: s.answeredAt } : {}),
    ...(reply ? { reply: stripTime(reply) } : {}),
  };
}

const stripTime = ({ answeredAt: _, ...reply }: PromptReply & { answeredAt: string }) =>
  reply as PromptReply;

/** Opens a permission prompt a push carried (or named). */
export async function openPushedPermission(ctx: Ctx, item: SealedItem): Promise<PromptItem> {
  const sent = (await store.get("promptAnswers", ctx.account)) ?? {};
  return openPermission(ctx, { item, cursor: "", receivedAt: "" }, sent);
}

/** Opens a waiting notice, with the machine that signed it. */
export async function openWaiting(ctx: Ctx, item: SealedItem) {
  const { signer, body } = await openAsync(expectKind(item, "waiting"), me(ctx), ctx.dir);
  return { machine: signer.id, waiting: body as Waiting };
}

/** Opens a settled notice, with the machine that signed it. */
export async function openSettled(ctx: Ctx, item: SealedItem) {
  const { signer, body } = await openAsync(expectKind(item, "settled"), me(ctx), ctx.dir);
  return { machine: signer.id, settled: body as Settled };
}

/** Settled notices after `cursor`, keyed by "machine/permission id". */
export async function loadSettled(ctx: Ctx, cursor?: string) {
  const out = new Map<string, Settled>();
  let at = cursor;
  for (;;) {
    const page = await api.items("settled", at);
    for (const s of page.items) {
      try {
        const { machine, settled } = await openSettled(ctx, s.item);
        out.set(`${machine}/${settled.itemId}`, settled);
      } catch {}
    }
    at = page.cursor;
    if (page.items.length < 100) return { settled: out, cursor: at };
  }
}

/** Reads every page of `kinds` from the start, opening what verifies. */
async function readAll<T>(
  kinds: string,
  opts: { open?: boolean },
  take: (s: Stored) => Promise<T>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await api.items(kinds, cursor, opts);
    for (const s of page.items) {
      try {
        out.push(await take(s));
      } catch {
        // A prompt that fails to verify is never shown: it could ask to allow anything.
      }
    }
    cursor = page.cursor;
    if (page.items.length < 100) return out;
  }
}

/** The prompts waiting now, whose answer window is still open. */
export async function loadPrompts(ctx: Ctx): Promise<PromptItem[]> {
  const sent = (await store.get("promptAnswers", ctx.account)) ?? {};
  return readAll("permission", { open: true }, (s) => openPermission(ctx, s, sent));
}

/** The last 7 days of prompts, with how each ended (the server keeps a week). */
export async function loadPromptLog(ctx: Ctx): Promise<PromptItem[]> {
  const sent = (await store.get("promptAnswers", ctx.account)) ?? {};
  const permissions = await readAll("permission", {}, (s) => openPermission(ctx, s, sent));
  const settled = await readAll("settled", {}, (s) =>
    openAsync(expectKind(s.item, "settled"), me(ctx), ctx.dir),
  );
  // A notice counts only from the machine that asked.
  const byId = new Map(settled.map((x) => [`${x.signer.id}/${x.body.itemId}`, x.body]));
  return permissions.map((p) => {
    const st = byId.get(`${p.machine.id}/${p.permission.id}`);
    return st ? { ...p, settled: st as Settled } : p;
  });
}

/**
 * Signs the answer, bound to the prompt's id and input hash, and seals it to the machine that
 * asked, which must still be active.
 */
export async function answerPermission(
  ctx: Ctx,
  item: PromptItem,
  reply: PromptReply,
): Promise<string> {
  const fresh = await refresh(ctx);
  const machine = fresh.dir.members.get(item.machine.id);
  if (!machine?.active) throw new Error(`${item.machine.name} was revoked`);
  const answeredAt = now();
  const sealed = await sealAsync(
    "permission-answer",
    {
      v: 1,
      id: randomId("pa_"),
      permissionId: item.permission.id,
      to: machine.member.id,
      answeredAt,
      inputHash: item.permission.inputHash,
      ...reply,
    },
    me(fresh),
    [machine.member],
  );
  await api.post(sealed);
  await store.update("promptAnswers", ctx.account, (sent) => ({
    ...sent,
    [item.permission.id]: { ...reply, answeredAt },
  }));
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
      opened = await openAsync(expectKind(s.item, "quota"), me(ctx), ctx.dir);
    } catch (e) {
      out.rejected.push({ id: s.item.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const { signer: machine, body } = opened;
    if (!out.takenAt || body.takenAt > out.takenAt) out.takenAt = body.takenAt;
    for (const p of body.providers) {
      if (p.error) out.errors.push({ provider: p.provider, machine: machine.name, error: p.error });
      for (const w of p.windows) {
        const alerts = body.alerts.filter((a) => a.provider === p.provider && a.window === w.id);
        // The card's state follows the pace alert; "low" only notifies.
        const alert = alerts.find((a) => a.kind !== "low");
        out.cards.push({
          provider: p.provider,
          ...(machines > 1 ? { machine: machine.name } : {}),
          window: w,
          ...(alert ? { alert } : {}),
          alerts,
          snapshot: body.id,
        });
      }
    }
  }
  return out;
}

// --- Runs -----------------------------------------------------------------------------------

export interface Runs {
  items: RunItem[];
  rejected: { id: string; error: string }[];
}

/** Every stored run: the server keeps the latest update of each, for a day. */
export async function loadRuns(ctx: Ctx): Promise<Runs> {
  const out: Runs = { items: [], rejected: [] };
  let cursor: string | undefined;
  for (;;) {
    const page = await api.items("run", cursor);
    for (const s of page.items) {
      try {
        const { signer, body } = await openAsync(expectKind(s.item, "run"), me(ctx), ctx.dir);
        out.items.push({ run: body, machine: signer.name });
      } catch (e) {
        if (e instanceof ProtocolError && e.code === "revoked-signer") continue;
        out.rejected.push({ id: s.item.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    cursor = page.cursor;
    if (page.items.length < 100) break;
  }
  return out;
}
