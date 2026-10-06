import {
  parseBody,
  parseWith,
  type SignFn,
  sign,
  signAsync,
  signatureMessage,
  verify,
} from "./envelope";
import { type DirectoryEntry, type Member, RECOVERY, SignedEnvelope } from "./schemas";
import { ProtocolError, sodium, toB64, utf8 } from "./sodium";

/** The account's members after replaying a verified chain. */
export interface Directory {
  account: string;
  /** The current recovery key: entry 0's, or the last confirmed replacement's. */
  recoveryPk: string;
  /**
   * The entry that made `recoveryPk` current (0, or a `recovery-confirm`'s seq), the device that
   * proposed it (entry 0's device for the first key), and when.
   */
  recoverySet: { seq: number; by: string; at: string };
  /** A proposed recovery key no confirmation has made current yet. */
  pendingRecovery?: { seq: number; recoveryPk: string; by: string; at: string };
  /** Every recovery key the chain named or proposed, retired ones too: none is used again. */
  recoveryPks: Set<string>;
  members: Map<string, { member: Member; active: boolean }>;
  /** Number of entries replayed. */
  length: number;
  /** Hash of the last entry's body; the next entry's `prev`. */
  head: string;
}

/** What a client remembers between fetches, so the server cannot roll the chain back. */
export interface Pin {
  length: number;
  head: string;
}

/** BLAKE2b-256 of an entry's body text. */
export function entryHash(body: string): string {
  return toB64(sodium.crypto_generichash(32, utf8(body), null));
}

export interface VerifyOptions {
  /** The account the chain must belong to. */
  account?: string;
  /** A chain seen before: this chain must extend it. */
  pin?: Pin;
  /** The recovery public key derived from the recovery key, when recovering: the chain's current one. */
  recoveryPk?: string;
}

/**
 * Replays the directory chain and checks every rule:
 * - entry 0 adds a device, is signed by that device's own key and by the recovery key it names;
 * - each later entry is signed by an active device or by the recovery key, has the next `seq`
 *   and the previous entry's hash as `prev`;
 * - machines sign no entries; the recovery key adds a device, revoking every other member, and
 *   confirms its own replacement, nothing else (`SIGNED_BY`);
 * - a new recovery key is proposed by a device, signed by itself, and confirmed by the current
 *   recovery key; from then on only the new key counts;
 * - ids and public keys are never reused, and revoked members stay revoked.
 */
export function verifyDirectory(entries: unknown[], opts: VerifyOptions = {}): Directory {
  if (entries.length === 0) throw new ProtocolError("bad-genesis", "empty chain");
  let dir: Directory | undefined;
  entries.forEach((raw, i) => {
    const env = parseWith(SignedEnvelope, raw);
    if (env.kind !== "directory") throw new ProtocolError("wrong-kind", `entry ${i}`);
    dir = dir ? applyEntry(dir, env, i) : genesis(env, opts);
  });
  const result = dir as Directory;
  if (opts.recoveryPk !== undefined && result.recoveryPk !== opts.recoveryPk)
    throw new ProtocolError("wrong-recovery-key", "recovery key differs");
  if (opts.pin) {
    const { length, head } = opts.pin;
    if (result.length < length || hashAt(entries, length - 1) !== head)
      throw new ProtocolError("rollback", "chain does not extend the pinned one");
  }
  return result;
}

/** Whether `entries` hold the chain `head` names: as long at least, and the same entry there. */
export function holdsHead(entries: unknown[], head: Pin): boolean {
  return head.length <= entries.length && hashAt(entries, head.length - 1) === head.head;
}

function hashAt(entries: unknown[], i: number): string | undefined {
  const env = SignedEnvelope.safeParse(entries[i]);
  return env.success ? entryHash(env.data.body) : undefined;
}

function genesis(env: SignedEnvelope, opts: VerifyOptions): Directory {
  // The first entry carries its own key, so it is parsed before its signature is checked;
  // nothing in it is trusted until the check passes.
  const body = parseBody("directory", env.body);
  if (body.op !== "add" || body.seq !== 0 || body.prev !== null)
    throw new ProtocolError("bad-genesis", "must be seq 0, prev null, op add");
  if (body.member.role !== "device") throw new ProtocolError("bad-genesis", "must add a device");
  if (env.signer !== body.member.id) throw new ProtocolError("bad-genesis", "must be self-signed");
  if (body.member.id === RECOVERY) throw new ProtocolError("duplicate-member", RECOVERY);
  if (!body.recoveryPk) throw new ProtocolError("bad-genesis", "missing recoveryPk");
  verify(env, body.member.signPk);
  if (!env.recoverySig) throw new ProtocolError("bad-genesis", "missing recoverySig");
  verify({ ...env, signer: RECOVERY, sig: env.recoverySig }, body.recoveryPk);
  if (opts.account !== undefined && body.account !== opts.account)
    throw new ProtocolError("wrong-account", body.account);
  return {
    account: body.account,
    recoveryPk: body.recoveryPk,
    recoverySet: { seq: 0, by: body.member.id, at: body.at },
    recoveryPks: new Set([body.recoveryPk]),
    members: new Map([[body.member.id, { member: body.member, active: true }]]),
    length: 1,
    head: entryHash(env.body),
  };
}

/**
 * Who signs each op: an active device or the recovery key. The recovery key adds a
 * device and confirms its own replacement, nothing else (#364).
 */
const SIGNED_BY = {
  add: "device",
  revoke: "device",
  recover: "recovery",
  recovery: "device",
  "recovery-confirm": "recovery",
} as const;

function applyEntry(dir: Directory, env: SignedEnvelope, i: number): Directory {
  let signPk: string;
  if (env.signer === RECOVERY) {
    signPk = dir.recoveryPk;
  } else {
    const signer = dir.members.get(env.signer);
    if (!signer) throw new ProtocolError("unknown-signer", `entry ${i}: ${env.signer}`);
    if (!signer.active) throw new ProtocolError("revoked-signer", `entry ${i}: ${env.signer}`);
    if (signer.member.role !== "device")
      throw new ProtocolError("signer-not-allowed", `entry ${i}: machines sign no entries`);
    signPk = signer.member.signPk;
  }
  verify(env, signPk);
  const body = parseBody("directory", env.body);
  if (body.seq !== i || body.prev !== dir.head)
    throw new ProtocolError("bad-chain", `entry ${i}: seq or prev`);
  if (body.account !== dir.account) throw new ProtocolError("wrong-account", `entry ${i}`);
  if (env.recoverySig !== undefined && body.op !== "recovery")
    throw new ProtocolError("bad-chain", `entry ${i}: only entry 0 and proposals have recoverySig`);
  const allowed = SIGNED_BY[body.op];
  if ((env.signer === RECOVERY) !== (allowed === "recovery"))
    throw new ProtocolError(
      "signer-not-allowed",
      `entry ${i}: a ${body.op} is signed by the ${allowed}`,
    );

  const members = new Map(dir.members);
  const next = { ...dir, members, length: i + 1, head: entryHash(env.body) };
  const addDevice = (m: Member) => {
    if (keyInUse(dir, m.signPk) || keyInUse(dir, m.boxPk) || members.has(m.id) || m.id === RECOVERY)
      throw new ProtocolError("duplicate-member", `entry ${i}: ${m.id}`);
    members.set(m.id, { member: m, active: true });
  };
  switch (body.op) {
    case "add": {
      if (body.recoveryPk !== undefined)
        throw new ProtocolError("bad-chain", `entry ${i}: only entry 0 names the recovery key`);
      addDevice(body.member);
      return next;
    }
    case "recover": {
      if (body.member.role !== "device")
        throw new ProtocolError("signer-not-allowed", `entry ${i}: recovery adds devices only`);
      // Every device is lost, or in someone else's hands: no member stays, machines included, so
      // a chain a server cut short of a revocation cannot bring a revoked one back (#363).
      for (const [id, e] of dir.members) if (e.active) members.set(id, { ...e, active: false });
      addDevice(body.member);
      next.pendingRecovery = undefined;
      return next;
    }
    case "revoke": {
      const target = members.get(body.id);
      if (!target?.active) throw new ProtocolError("unknown-member", `entry ${i}: ${body.id}`);
      members.set(body.id, { member: target.member, active: false });
      // A revoked device's proposal goes with it.
      if (dir.pendingRecovery?.by === body.id) next.pendingRecovery = undefined;
      return next;
    }
    case "recovery": {
      if (!env.recoverySig)
        throw new ProtocolError("bad-recovery", `entry ${i}: missing the new key's recoverySig`);
      verify({ ...env, signer: RECOVERY, sig: env.recoverySig }, body.recoveryPk);
      if (keyInUse(dir, body.recoveryPk))
        throw new ProtocolError("bad-recovery", `entry ${i}: the key is already in use`);
      next.pendingRecovery = { seq: i, recoveryPk: body.recoveryPk, by: env.signer, at: body.at };
      next.recoveryPks = new Set([...dir.recoveryPks, body.recoveryPk]);
      return next;
    }
    case "recovery-confirm": {
      const pending = dir.pendingRecovery;
      if (!pending || body.proposal !== pending.seq || body.recoveryPk !== pending.recoveryPk)
        throw new ProtocolError("bad-recovery", `entry ${i}: no pending proposal ${body.proposal}`);
      next.recoveryPk = pending.recoveryPk;
      next.recoverySet = { seq: i, by: pending.by, at: body.at };
      next.pendingRecovery = undefined;
      return next;
    }
  }
}

/**
 * Whether `pk` is any member's key or any recovery key the chain named, current, proposed or
 * retired: keys are never reused, across members and across roles.
 */
function keyInUse(dir: Directory, pk: string): boolean {
  if (dir.recoveryPks.has(pk)) return true;
  for (const { member } of dir.members.values())
    if (member.signPk === pk || member.boxPk === pk) return true;
  return false;
}

export function activeMembers(dir: Directory, role: Member["role"]): Member[] {
  return [...dir.members.values()]
    .filter((e) => e.active && e.member.role === role)
    .map((e) => e.member);
}

// --- Writing entries ---------------------------------------------------------

interface GenesisArgs {
  account: string;
  device: Member;
  /** The recovery key pair, used here once and then shown as a recovery key and dropped. */
  recovery: { publicKey: Uint8Array; privateKey: Uint8Array };
  at: string;
}

function genesisBody(args: GenesisArgs): DirectoryEntry {
  return {
    v: 1,
    account: args.account,
    seq: 0,
    prev: null,
    at: args.at,
    op: "add",
    member: args.device,
    recoveryPk: toB64(args.recovery.publicKey),
  };
}

function withRecoverySig(env: SignedEnvelope, recoveryKey: Uint8Array): SignedEnvelope {
  const recoverySig = sodium.crypto_sign_detached(
    signatureMessage("directory", RECOVERY, env.body),
    recoveryKey,
  );
  return { ...env, recoverySig: toB64(recoverySig) };
}

export function genesisEntry(args: GenesisArgs & { signKey: Uint8Array }): SignedEnvelope {
  const env = sign("directory", genesisBody(args), args.device.id, args.signKey);
  return withRecoverySig(env, args.recovery.privateKey);
}

/** `genesisEntry` with the device's `SignFn`. */
export async function genesisEntryAsync(
  args: GenesisArgs & { sign: SignFn },
): Promise<SignedEnvelope> {
  const env = await signAsync("directory", genesisBody(args), args.device.id, args.sign);
  return withRecoverySig(env, args.recovery.privateKey);
}

type Change =
  | { op: "add"; member: Member }
  | { op: "revoke"; id: string }
  | { op: "recover"; member: Member }
  | { op: "recovery"; recoveryPk: string }
  | { op: "recovery-confirm"; proposal: number; recoveryPk: string };

function nextBody(dir: Directory, at: string, change: Change): DirectoryEntry {
  return { v: 1, account: dir.account, seq: dir.length, prev: dir.head, at, ...change };
}

/** `signer.id` is an active device's id. */
export function addEntry(
  dir: Directory,
  signer: { id: string; signKey: Uint8Array },
  member: Member,
  at: string,
): SignedEnvelope {
  return sign("directory", nextBody(dir, at, { op: "add", member }), signer.id, signer.signKey);
}

export function revokeEntry(
  dir: Directory,
  signer: { id: string; signKey: Uint8Array },
  id: string,
  at: string,
): SignedEnvelope {
  return sign("directory", nextBody(dir, at, { op: "revoke", id }), signer.id, signer.signKey);
}

/** `addEntry` with an active device's `SignFn`. */
export function addEntryAsync(
  dir: Directory,
  signer: { id: string; sign: SignFn },
  member: Member,
  at: string,
): Promise<SignedEnvelope> {
  return signAsync("directory", nextBody(dir, at, { op: "add", member }), signer.id, signer.sign);
}

/** `revokeEntry` with an active device's `SignFn`. */
export function revokeEntryAsync(
  dir: Directory,
  signer: { id: string; sign: SignFn },
  id: string,
  at: string,
): Promise<SignedEnvelope> {
  return signAsync("directory", nextBody(dir, at, { op: "revoke", id }), signer.id, signer.sign);
}

/** Adds `member`, a device, with the recovery private key, and revokes every other member. */
export function recoverEntry(
  dir: Directory,
  recoveryKey: Uint8Array,
  member: Member,
  at: string,
): SignedEnvelope {
  return sign("directory", nextBody(dir, at, { op: "recover", member }), RECOVERY, recoveryKey);
}

/**
 * Proposes `recovery` (a new key pair, shown as a key and then dropped) as the recovery key,
 * signed by an active device and by the new key.
 */
export async function recoveryEntryAsync(
  dir: Directory,
  signer: { id: string; sign: SignFn },
  recovery: { publicKey: Uint8Array; privateKey: Uint8Array },
  at: string,
): Promise<SignedEnvelope> {
  const change = { op: "recovery", recoveryPk: toB64(recovery.publicKey) } as const;
  const env = await signAsync("directory", nextBody(dir, at, change), signer.id, signer.sign);
  return withRecoverySig(env, recovery.privateKey);
}

/** `recoveryEntryAsync` with a raw signing key. */
export function recoveryEntry(
  dir: Directory,
  signer: { id: string; signKey: Uint8Array },
  recovery: { publicKey: Uint8Array; privateKey: Uint8Array },
  at: string,
): SignedEnvelope {
  const change = { op: "recovery", recoveryPk: toB64(recovery.publicKey) } as const;
  const env = sign("directory", nextBody(dir, at, change), signer.id, signer.signKey);
  return withRecoverySig(env, recovery.privateKey);
}

/**
 * Confirms the pending proposal of `recoveryPk` with the current recovery private key; refuses
 * when another proposal replaced it, so the owner never confirms a key they did not make.
 */
export function recoveryConfirmEntry(
  dir: Directory,
  recoveryKey: Uint8Array,
  recoveryPk: string,
  at: string,
): SignedEnvelope {
  const pending = dir.pendingRecovery;
  if (pending?.recoveryPk !== recoveryPk)
    throw new ProtocolError("bad-recovery", "the pending proposal is not this key");
  const change = { op: "recovery-confirm", proposal: pending.seq, recoveryPk } as const;
  return sign("directory", nextBody(dir, at, change), RECOVERY, recoveryKey);
}
