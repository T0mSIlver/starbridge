// Everything this browser does as a device: setup, the session, pairing and recovery. Each kind
// of item (decisions, prompts, quotas, runs, join requests) lives in kinds/, on the chain and keys
// of kinds/core.ts, and is re-exported here. Components import this module dynamically, so
// libsodium and the protocol code load after the first paint. Every read of the directory replays
// the chain against the pin kept in IndexedDB.
import {
  bindMessage,
  checkCode,
  checkJoined,
  codeFromLink,
  type Directory,
  DirectoryEntry,
  formatPairingCode,
  generateRecoverySeed,
  genesisEntryAsync,
  type Held,
  claimHash as hashClaim,
  type JoinKeys,
  joinCommitment,
  joinerKeys,
  joinRequest,
  type Member,
  newClaimSecret,
  newJoinId,
  newJoinKeyPair,
  newPairingCode,
  openJoinApproval,
  openPairingApproval,
  openPairingRequest,
  type PairingCode,
  ProtocolError,
  pairingApproval,
  pairingLink,
  pairingRequest,
  parsePairingCode,
  RecoveryKeyError,
  type RecoveryKeyReading,
  readRecoveryKey,
  ready,
  recoverEntry,
  recoveryConfirmEntry,
  recoveryEntryAsync,
  recoveryKey,
  recoveryKeyPair,
  recoverySeedFromKey,
  revokeEntryAsync,
  type SignedEnvelope,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { ApiError, api } from "./api";
import { generateDeviceKeys, signer } from "./crypto/keys";
import { desktop } from "./desktop";
import {
  append,
  appendMember,
  type Ctx,
  heldRemoval,
  me,
  now,
  pinTo,
  randomId,
  refresh,
  reverify,
  stopWaiting,
  trusted,
  Unanchored,
} from "./kinds/core";
import { forgetKeptSealed } from "./kinds/decisions";
import { retrying } from "./kinds/joins";
import { otherServer } from "./otherServer";
import { signedOut } from "./signedOut";
import * as store from "./store";
import { ACCOUNT_STORAGE_KEYS } from "./stored";
import type { Device, PairingRequest } from "./types";

export { type Ctx, heldText, reverify, stopWaiting, Withheld } from "./kinds/core";
export * from "./kinds/decisions";
// By name: `retrying` stays inside, shared with the joining side here.
export {
  type Comparison,
  compareJoin,
  refuseJoin,
  retryDelay,
  watchJoins,
} from "./kinds/joins";
export * from "./kinds/prompts";
export * from "./kinds/quotas";
export * from "./kinds/runs";
export { ApiError };

export type Boot =
  /**
   * `known`: this browser holds a device of the account it last signed in to. `refused`: the
   * server's reason for ending the session, unsigned, so the keys stay until the chain agrees.
   */
  | { state: "signed-out"; known: boolean; refused?: string }
  /** `unsaved`: the name of a first device whose page closed before its recovery key was saved. */
  | { state: "first-device"; account: string; unsaved?: string }
  /** The account has devices and this browser is not one of them (or lost its binding). */
  | { state: "join"; account: string; stale: boolean }
  /** `by`: the device that revoked this one, or the recovery key. */
  | { state: "revoked"; account: string; name: string; by: string }
  /** The directory failed verification: the server, or someone holding it, broke the chain. */
  | { state: "broken"; account: string; error: string }
  /**
   * The chain drops this browser, but a machine's head shows entries it lacks: the keys stay
   * (#1779). `revoked`: the member whose heads the owner can tell this browser to forget (#813).
   */
  | { state: "held"; account: string; text: string; revoked?: { id: string; name: string } }
  | { state: "ready"; ctx: Ctx };

/** A default device name from the user agent, such as "Firefox on Mac". */
export function defaultName(): string {
  const ua = navigator.userAgent;
  // The desktop app names itself, not the Chromium inside it (#905).
  if (desktop)
    return `Starbridge on ${/Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Mac"}`;
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

function registration() {
  return (
    navigator.serviceWorker?.getRegistration("/").catch(() => undefined) ??
    Promise.resolve(undefined)
  );
}

/**
 * Closes every notification the service worker shows. They stay up until dismissed and carry
 * decrypted questions, so they go when this browser stops being the device that read them (#311).
 */
async function closeNotifications(): Promise<void> {
  const reg = await registration();
  for (const n of (await reg?.getNotifications().catch(() => [])) ?? []) n.close();
}

export async function boot(): Promise<Boot> {
  // Off the load's path: images a tab from before #2097 left when it signed out. Signed out,
  // `signedOut` sweeps them.
  store.sweepBlobs().catch(() => {});
  let me: Awaited<ReturnType<typeof api.me>>;
  try {
    me = await api.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      // A "revoked" here is the server's word only: the keys stay, and the next sign-in reads
      // the chain, which alone revokes a device (#310). Closing notifications loses nothing.
      if (e.code === "revoked") await closeNotifications();
      return signedOut(e.code === "revoked" ? e.code : undefined);
    }
    throw e;
  }
  await ready;
  const { account } = me;
  await store.put("current", account);
  let device = await store.get("device", account);
  const entries = await api.directory();
  if (entries.length === 0) {
    // A browser that pinned a chain never accepts an empty one: that would be a rollback.
    if (await store.get("pin", account))
      return { state: "broken", account, error: "rollback: the server sent an empty directory" };
    // Keys saved before a genesis that never reached the server: the page closed before the
    // owner saved the recovery key, so that key was never used (#328). Once the genesis may
    // have gone out, only the server could make the directory empty: the keys stay (#371).
    if (device?.posted)
      return { state: "broken", account, error: "the server sent an empty directory" };
    if (device) await store.del("device", account);
    return { state: "first-device", account, ...(device ? { unsaved: device.name } : {}) };
  }
  let verified: { dir: Directory; entries: SignedEnvelope[] };
  try {
    verified = await trusted(account, entries);
  } catch (e) {
    // A join or recovery cut off before it pinned starts over (#354).
    if (e instanceof Unanchored) {
      await store.del("pending", account);
      return { state: "join", account, stale: false };
    }
    return { state: "broken", account, error: e instanceof Error ? e.message : String(e) };
  }
  // A join a device approved, or a recovery whose append landed, cut off before its keys became
  // the device: the directory already lists them, so they are, as they would have been had it
  // finished, even over an older device's (#274, #283).
  const pending = await store.get("pending", account);
  const held = pending && verified.dir.members.get(pending.id);
  if (
    pending &&
    held?.active &&
    held.member.boxPk === pending.boxPk &&
    held.member.signPk === pending.signPk
  ) {
    await adopt(account, pending);
    device = pending;
  }
  if (!device) return { state: "join", account, stale: false };
  const entry = verified.dir.members.get(device.id);
  if (!entry || entry.member.boxPk !== device.boxPk || entry.member.signPk !== device.signPk) {
    // Saved before a pairing or recovery that never completed.
    await store.del("device", account);
    return { state: "join", account, stale: false };
  }
  if (!entry.active) {
    // A chain the server cut short can drop this browser too: a machine's head shows it (#1779).
    const held = await heldRemoval(account, verified);
    if (held)
      return {
        state: "held",
        account,
        text: removalText(verified.dir, held),
        ...(held.revoked
          ? { revoked: { id: held.id, name: memberName(verified.dir, held.id) } }
          : {}),
      };
    // The chain says so, unlike a 401: this browser's keys and what it answered go, as Android's
    // wipe does. The pin stays, so the server still cannot roll the chain back.
    const reg = await registration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {});
    for (const kind of ["device", "answers", "promptAnswers", "kept"] as const)
      await store.del(kind, account);
    forgetKeptSealed(account);
    await closeNotifications();
    return { state: "revoked", account, name: device.name, by: removedBy(verified, device.id) };
  }
  if (me.member === null && !(await bind(account, device))) {
    return { state: "join", account, stale: true };
  } else if (me.member !== null && me.member !== device.id) {
    return { state: "join", account, stale: true };
  }
  return { state: "ready", ctx: { account, device, ...verified } };
}

const memberName = (dir: Directory, id: string) => dir.members.get(id)?.member.name ?? id;

/** Why this browser keeps its keys on a chain that drops it: names the machine that saw more. */
export function removalText(dir: Directory, held: Held): string {
  const machine = memberName(dir, held.id);
  const text = `The server's list of your devices says this browser was removed, but ${machine} has seen changes to it that the server is holding back. This browser keeps its keys until the server sends them.`;
  if (!held.revoked) return text;
  return `${text} ${memberName(dir, held.revoked.by)} revoked ${machine} on ${held.revoked.at.slice(0, 10)}: if you did, stop waiting.`;
}

/** Who removed member `id`: the device that signed its revocation, or the recovery key. */
function removedBy(chain: { dir: Directory; entries: SignedEnvelope[] }, id: string): string {
  let added = false;
  for (const env of chain.entries) {
    const body = JSON.parse(env.body) as { op: string; id?: string; member?: { id: string } };
    if (body.member?.id === id) added = true;
    else if (added && body.op === "recover") return "your recovery key";
    else if (added && body.op === "revoke" && body.id === id)
      return chain.dir.members.get(env.signer)?.member.name ?? env.signer;
  }
  return "another device";
}

/**
 * Signed in again: proves this browser holds the device's key, so the session becomes its own.
 * Another tab may bind the same session meanwhile, so a failure checks /me before retrying.
 */
/** How often, and after what waits, signing in retries a binding that failed for want of a reply. */
export const bindRetry = { waits: [500, 2_000, 5_000] };

/**
 * Binds this sign-in session to the device: true once bound, false when the server refuses the
 * device's signature. A failure that is not a refusal (network, 5xx, rate limit) retries, then
 * throws, so a passing outage never sends a browser with valid keys to pair again (#274).
 */
async function bind(account: string, device: store.DeviceRecord): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const nonce = await api.challenge();
      const sig = await signer(device.keys)(bindMessage(account, device.id, nonce));
      await api.bind(device.id, toB64(sig));
      return true;
    } catch (e) {
      const me = await api.me().catch(() => undefined);
      if (me?.member === device.id) return true;
      const refused =
        e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
      if (refused) return false;
      const wait = bindRetry.waits[attempt];
      if (wait === undefined) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
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

/** A first device whose keys and recovery key exist, not yet on the server. */
export interface FirstDevice {
  recoveryKey: string;
  /**
   * Signs the genesis with this device's name, then posts it. Safe to call again after a
   * failure: the retry reuses the entry signed first, name included.
   */
  commit: (name: string) => Promise<void>;
}

/**
 * Makes this browser's keys and the recovery key, shown before `commit`, which runs once the
 * owner says it is saved and signs the account's genesis with the name typed beside it (#2139).
 * A page closed before that posts no genesis, and boot offers a new key (#328). The recovery
 * key pair stays in memory until the genesis is signed: no longer than the key stays on screen.
 */
export async function prepareFirstDevice(account: string, name: string): Promise<FirstDevice> {
  await ready;
  const { record } = await newDevice(account, name);
  const seed = crypto.getRandomValues(new Uint8Array(16));
  const recovery = recoveryKeyPair(seed);
  let shown: string;
  try {
    shown = recoveryKey(seed);
  } finally {
    seed.fill(0);
  }
  // Another tab posted its genesis since this page offered a key: its keys are the account's.
  if ((await store.get("device", account))?.posted)
    throw new Error("Another tab set up this account. Reload.");
  await store.put("device", record, account);
  let signed: { entry: SignedEnvelope; dir: Directory; named: store.DeviceRecord } | undefined;
  const sign = async (typed: string) => {
    const named = { ...record, name: typed };
    const member: Member = {
      id: named.id,
      role: "device",
      name: typed,
      boxPk: named.boxPk,
      signPk: named.signPk,
    };
    const entry = await genesisEntryAsync({
      account,
      device: member,
      sign: signer(named.keys),
      recovery,
      at: now(),
    });
    const dir = verifyDirectory([entry], { account });
    // Signed once: a retry reuses this entry, so the key has nothing left to sign.
    recovery.privateKey.fill(0);
    return { entry, dir, named };
  };
  const commit = async (typed: string) => {
    // Another tab's boot drops these keys as never used, or its setup replaces them: posting
    // now would make an account whose device keys no browser holds.
    const held = await store.get("device", account);
    if (held?.id !== record.id || held.signPk !== record.signPk)
      throw new Error("Another tab started the setup over, so this key was never used. Reload.");
    signed ??= await sign(typed);
    const { entry, dir, named } = signed;
    await store.put("device", { ...named, posted: true }, account);
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
 * Adds this browser with the recovery key, when every device is lost. Entry 0's recovery
 * signature must check against the key typed, so a server cannot serve a chain of its own here.
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
      // Another account's key, or this account's from before a replacement (#348).
      if (e instanceof ProtocolError && e.code === "wrong-recovery-key")
        throw new Error("This is a recovery key, but not this account's current one.");
      throw e;
    }
    // Revokes every other member: recovery means they are lost, or in someone else's hands (#363).
    const entry = recoverEntry(dir, recovery.privateKey, member, now());
    const next = verifyDirectory([...entries, entry], { account });
    // Pending until the append lands: a failed one must not replace keys that still work (#283).
    await store.put("pending", record, account);
    try {
      await api.append(entry);
    } catch (e) {
      // It may have landed with its response lost: it did if the directory holds it.
      const landed = await api.directory().catch(() => []);
      if (!landed.some((x) => x.sig === entry.sig)) throw e;
    }
    await pinTo(account, [...entries, entry], next);
    await adopt(account, record);
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
  return { complete: reading.count === 28, status: `${reading.count} of 28 characters` };
}

function problemText({ problem }: RecoveryKeyReading): string | undefined {
  switch (problem?.kind) {
    case undefined:
      return undefined;
    case "bad-character":
      return `Character ${problem.index + 1}, "${problem.char}", is not in a recovery key.`;
    case "length":
      return `A recovery key has 28 characters; this has ${problem.count}.`;
    case "checksum":
      return "A character is wrong. Check each group against what you wrote down.";
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
  await store.put("pending", record, account);
  await api.requestPairing(request, hashClaim(claim));
  const abort = new AbortController();
  const done = (async () => {
    for (;;) {
      if (abort.signal.aborted) throw new Error("cancelled");
      const res = await api.pairingResult(code.rendezvous, claim, 25, abort.signal);
      if (res) return finishJoin(account, code, res.approval, record, member);
    }
  })();
  return { code: formatPairingCode(code), done, cancel: () => abort.abort() };
}

/** New keys become this browser's device; notifications the older keys read go (#311). */
async function adopt(account: string, record: store.DeviceRecord): Promise<void> {
  await store.put("device", record, account);
  await store.del("pending", account);
  await closeNotifications();
}

async function finishJoin(
  account: string,
  code: PairingCode,
  approval: unknown,
  record: store.DeviceRecord,
  member: Member,
) {
  const body = openPairingApproval(approval, code);
  if (body.account !== account) throw new ProtocolError("wrong-account", body.account);
  const entries = await api.directory();
  // The approval's length and head, under the code's MAC, pin a directory the server cannot fake.
  const dir = verifyDirectory(entries, { account, pin: { length: body.length, head: body.head } });
  checkJoined(dir, member);
  await pinTo(account, entries, dir);
  await adopt(account, record);
}

/** Joining by digits: no code to type; the owner compares 6 digits on both devices. */
export interface DigitJoin {
  /** Resolves once a device took the request: the digits it shows too. */
  digits: Promise<string>;
  /** Resolves once that device approved, this browser's owner confirmed the digits match, and
   * the directory holds this browser's keys. */
  done: Promise<void>;
  /** This browser's owner saw the same digits on the other device. */
  confirm: () => void;
  cancel: () => void;
}

export async function startDigitJoin(account: string, name: string): Promise<DigitJoin> {
  await ready;
  const { record, member } = await newDevice(account, name);
  const eph = newJoinKeyPair();
  const id = newJoinId();
  const { role: _, ...keys } = member;
  const request = joinRequest({ v: 1, join: id, account, ...keys, at: now() });
  await store.put("pending", record, account);
  const { expiresAt } = (await api.postJoin(request, joinCommitment(eph.publicKey, request))).join;
  const abort = new AbortController();
  let confirm: () => void = () => {};
  const confirmed = new Promise<void>((resolve, reject) => {
    confirm = resolve;
    abort.signal.addEventListener("abort", () => reject(new Error("cancelled")));
  });
  confirmed.catch(() => {});
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
          if (abort.signal.aborted) throw new Error("cancelled");
          shown(derived.digits);
        }
        if (derived && join.approval !== undefined) {
          const body = openJoinApproval(join.approval, derived, id);
          // The approval's MAC proves only that whoever sent the approver key approved, which
          // may be the server: it counts once this browser's owner has seen the digits match
          // (#355).
          await confirmed;
          if (body.account !== account) throw new ProtocolError("wrong-account", body.account);
          const entries = await api.directory();
          const dir = verifyDirectory(entries, {
            account,
            pin: { length: body.length, head: body.head },
          });
          checkJoined(dir, member);
          await pinTo(account, entries, dir);
          await adopt(account, record);
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
    confirm,
    cancel: () => {
      abort.abort();
      api.cancelJoin(id).catch(() => {});
    },
  };
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

export function devices(ctx: Ctx): Device[] {
  const addedAt = new Map<string, string>();
  for (const env of ctx.entries) {
    const body = DirectoryEntry.parse(JSON.parse(env.body));
    if (body.op === "add" || body.op === "recover") addedAt.set(body.member.id, body.at);
  }
  return [...ctx.dir.members.values()].map(({ member, active }) => ({
    ...member,
    addedAt: addedAt.get(member.id) ?? "",
    status: active ? "active" : "revoked",
    self: member.id === ctx.device.id,
    ...(active && member.role === "machine" ? checkOf(ctx.entries, member.id) : {}),
  }));
}

/** A machine's check code; none rather than no list when its entry will not hash. */
function checkOf(entries: unknown[], id: string): { check?: string } {
  try {
    return { check: checkCode(entries, id) };
  } catch {
    return {};
  }
}

/** Fetches the request under the typed code and checks its MAC: the server cannot swap keys. */
export async function readPairing(codeText: string): Promise<PairingRequest> {
  await ready;
  const code = codeFromLink(codeText);
  let request: unknown;
  try {
    ({ request } = await api.pairing(code.rendezvous));
  } catch (e) {
    const other =
      e instanceof ApiError && e.status === 404 ? otherServer(codeText, location.host) : undefined;
    if (other)
      throw new Error(
        `This code is from ${other}, and this browser is signed in to ${location.host}.`,
      );
    throw e;
  }
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

/**
 * Revokes member `id`, and forgets the directory heads it signed: this browser
 * signed the revocation, so it knows it is no fork, and a head the member forged ends with it.
 */
export async function revoke(ctx: Ctx, id: string): Promise<Ctx> {
  const next = await append(ctx, (dir) => revokeEntryAsync(dir, me(ctx), id, now()));
  await stopWaiting(next, id);
  return next;
}

// --- Replacing the recovery key (#348) ---------------------------------------------------

/** The recovery key as Settings and the notices show it; device names, not ids. */
export interface RecoveryState {
  /** When the current key was set, on which device, and whether it replaced an earlier one. */
  set: { at: string; by: string; replaced: boolean };
  /** A replacement made on another device since this browser joined, to show once. */
  notice?: { seq: number; at: string; by: string };
}

export async function recoveryState(ctx: Ctx): Promise<RecoveryState> {
  const name = (id: string) =>
    id === ctx.device.id
      ? desktop
        ? "this app"
        : "this browser"
      : (ctx.dir.members.get(id)?.member.name ?? id);
  const set = ctx.dir.recoverySet;
  const joined = ctx.entries.findIndex((env) => {
    const body = DirectoryEntry.parse(JSON.parse(env.body));
    return (body.op === "add" || body.op === "recover") && body.member.id === ctx.device.id;
  });
  const seen = (await store.get("recoverySeen", ctx.account)) ?? -1;
  const fresh = set.seq > 0 && set.seq > joined && set.seq > seen && set.by !== ctx.device.id;
  return {
    set: { at: set.at, by: name(set.by), replaced: set.seq > 0 },
    ...(fresh ? { notice: { seq: set.seq, at: set.at, by: name(set.by) } } : {}),
  };
}

/** Hides the notice of the replacement at `seq` on this browser. */
export function dismissRecoveryNotice(ctx: Ctx, seq: number): Promise<void> {
  return store.put("recoverySeen", seq, ctx.account);
}

/** A new recovery key, shown before anything is posted. */
export interface NewRecoveryKey {
  recoveryKey: string;
  /**
   * Proposes the key and confirms it with the current one. Safe to call again after a failure:
   * it picks up where it stopped.
   */
  replace: () => Promise<Ctx>;
  /** Wipes both private keys, when the page closes without saving. */
  discard: () => void;
}

/**
 * Makes a new recovery key to show, once the owner typed the current one: both sign, so neither
 * a stolen device nor a leaked key replaces it alone. Like the first device's key (#328), the
 * new one reaches the directory only once the owner says it is saved.
 */
export async function prepareRecoveryKey(ctx: Ctx, currentKey: string): Promise<NewRecoveryKey> {
  await ready;
  let seed: Uint8Array;
  try {
    seed = recoverySeedFromKey(currentKey);
  } catch (e) {
    throw e instanceof RecoveryKeyError ? new Error(problemText(e.reading) ?? e.message) : e;
  }
  const current = recoveryKeyPair(seed);
  seed.fill(0);
  // Against the chain as it is now: another device may have replaced the key since boot.
  if (toB64(current.publicKey) !== (await refresh(ctx)).dir.recoveryPk) {
    current.privateKey.fill(0);
    throw new Error("This isn't the account's current recovery key.");
  }
  const fresh = generateRecoverySeed();
  const next = recoveryKeyPair(fresh);
  const shown = recoveryKey(fresh);
  fresh.fill(0);
  const nextPk = toB64(next.publicKey);
  // A save in flight still signs with both keys: leaving the page then wipes them when it ends.
  let saving = false;
  let dropped = false;
  const wipe = () => {
    next.privateKey.fill(0);
    current.privateKey.fill(0);
  };
  const replace = async () => {
    saving = true;
    try {
      const latest = await save();
      wipe();
      return latest;
    } finally {
      saving = false;
      if (dropped) wipe();
    }
  };
  const save = async () => {
    let latest: Ctx;
    try {
      latest = await refresh(ctx);
    } catch (e) {
      if (e instanceof ApiError && e.code === "revoked") throw removed();
      throw e;
    }
    // A recovery or a revocation dropped this browser, and its proposal with it; or the server
    // cut the chain short, which a machine's head shows (#1779).
    if (!latest.dir.members.get(ctx.device.id)?.active) {
      const held = await heldRemoval(ctx.account, latest);
      throw held ? new Error(removalText(latest.dir, held)) : removed();
    }
    // Another device replaced the key since it was typed: the confirmation could never verify.
    if (latest.dir.recoveryPk !== nextPk && latest.dir.recoveryPk !== toB64(current.publicKey))
      throw new Error("Another device replaced the recovery key meanwhile. Start again.");
    if (latest.dir.recoveryPk !== nextPk) {
      // A retry after the proposal landed confirms it rather than proposing the same key again;
      // one another proposal replaced meanwhile can never be posted again.
      if (latest.dir.pendingRecovery?.recoveryPk !== nextPk && latest.dir.recoveryPks.has(nextPk))
        throw new Error("Another device proposed a new key meanwhile. Start again.");
      if (latest.dir.pendingRecovery?.recoveryPk !== nextPk)
        latest = await append(latest, (dir) => recoveryEntryAsync(dir, me(latest), next, now()));
      latest = await append(latest, async (dir) =>
        recoveryConfirmEntry(dir, current.privateKey, nextPk, now()),
      );
    }
    return latest;
  };
  const discard = () => {
    if (saving) dropped = true;
    else wipe();
  };
  const removed = () => new Error("This browser was removed from the account.");
  return { recoveryKey: shown, replace, discard };
}

/**
 * Signs this browser out, as Android's Sign out does: it leaves the account's devices unless it
 * is the last one (which would leave only the recovery key), ends its session, drops its push
 * subscription and forgets its keys and what it answered.
 */
export async function signOut(stale: Ctx): Promise<void> {
  // Count devices on the directory as it is now, as Android does: another one may have been
  // revoked since this page loaded. Undefined: this browser was revoked already.
  const ctx = await reverify(stale).catch(() => stale);
  const others = [...(ctx?.dir.members.values() ?? [])].filter(
    (m) => m.member.role === "device" && m.active && m.member.id !== stale.device.id,
  );
  if (ctx && others.length > 0) await revoke(ctx, ctx.device.id).catch(() => {});
  await api.logout().catch(() => {});
  await forget(stale.account);
}

/**
 * Deletes the account on the server (#1104), which signs out every device and machine, then
 * forgets it here as Sign out does. A failed delete throws and forgets nothing. A session not yet
 * paired may delete too (#1117).
 */
export async function deleteAccount(account: string): Promise<void> {
  await api.deleteAccount();
  await forget(account);
}

/** Drops this browser's push subscription, and its keys and what it answered for `account`. */
async function forget(account: string): Promise<void> {
  const reg = await registration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {});
  for (const kind of store.ACCOUNT_KINDS) await store.del(kind, account);
  forgetKeptSealed(account);
  await store.del("current");
  // Not in a service worker, which has no localStorage; a browser that blocks storage throws on
  // the read itself.
  const local = (() => {
    try {
      return (globalThis as { localStorage?: { removeItem(key: string): void } }).localStorage;
    } catch {
      return undefined;
    }
  })();
  for (const key of Object.values(ACCOUNT_STORAGE_KEYS)) {
    try {
      local?.removeItem(key);
    } catch {}
  }
  // Last: a push the service worker was still opening finds no keys now.
  await closeNotifications();
}
