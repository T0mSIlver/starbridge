import { parseBody, parseWith, sign, verify } from "./envelope";
import { type DirectoryEntry, type Member, RECOVERY, SignedEnvelope } from "./schemas";
import { ProtocolError, sodium, toB64, utf8 } from "./sodium";

/** The account's members after replaying a verified chain. */
export interface Directory {
  account: string;
  recoveryPk: string;
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
  /** The recovery public key derived from the words, when recovering. */
  recoveryPk?: string;
}

/**
 * Replays the directory chain and checks every rule:
 * - entry 0 adds a device, is signed by that device's own key and names the recovery key;
 * - each later entry is signed by an active device or by the recovery key, has the next `seq`
 *   and the previous entry's hash as `prev`;
 * - machines sign no entries, the recovery key adds only devices;
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
  if (opts.pin) {
    const { length, head } = opts.pin;
    if (result.length < length || hashAt(entries, length - 1) !== head)
      throw new ProtocolError("rollback", "chain does not extend the pinned one");
  }
  return result;
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
  if (opts.account !== undefined && body.account !== opts.account)
    throw new ProtocolError("wrong-account", body.account);
  if (opts.recoveryPk !== undefined && body.recoveryPk !== opts.recoveryPk)
    throw new ProtocolError("bad-genesis", "recovery key differs");
  return {
    account: body.account,
    recoveryPk: body.recoveryPk,
    members: new Map([[body.member.id, { member: body.member, active: true }]]),
    length: 1,
    head: entryHash(env.body),
  };
}

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

  const members = new Map(dir.members);
  if (body.op === "add") {
    if (body.recoveryPk !== undefined)
      throw new ProtocolError("bad-chain", `entry ${i}: only entry 0 names the recovery key`);
    const m = body.member;
    if (env.signer === RECOVERY && m.role !== "device")
      throw new ProtocolError("signer-not-allowed", `entry ${i}: recovery adds devices only`);
    const reused = [...members.values()].some(
      ({ member }) =>
        member.id === m.id ||
        member.signPk === m.signPk ||
        member.boxPk === m.boxPk ||
        member.signPk === m.boxPk ||
        member.boxPk === m.signPk,
    );
    if (reused || m.id === RECOVERY || m.signPk === dir.recoveryPk)
      throw new ProtocolError("duplicate-member", `entry ${i}: ${m.id}`);
    members.set(m.id, { member: m, active: true });
  } else {
    const target = members.get(body.id);
    if (!target?.active) throw new ProtocolError("unknown-member", `entry ${i}: ${body.id}`);
    members.set(body.id, { member: target.member, active: false });
  }
  return { ...dir, members, length: i + 1, head: entryHash(env.body) };
}

export function activeMembers(dir: Directory, role: Member["role"]): Member[] {
  return [...dir.members.values()]
    .filter((e) => e.active && e.member.role === role)
    .map((e) => e.member);
}

// --- Writing entries ---------------------------------------------------------

export function genesisEntry(args: {
  account: string;
  device: Member;
  signKey: Uint8Array;
  recoveryPk: string;
  at: string;
}): SignedEnvelope {
  const body: DirectoryEntry = {
    v: 1,
    account: args.account,
    seq: 0,
    prev: null,
    at: args.at,
    op: "add",
    member: args.device,
    recoveryPk: args.recoveryPk,
  };
  return sign("directory", body, args.device.id, args.signKey);
}

/** `signer.id` is an active device's id, or RECOVERY with the recovery private key. */
export function addEntry(
  dir: Directory,
  signer: { id: string; signKey: Uint8Array },
  member: Member,
  at: string,
): SignedEnvelope {
  const body: DirectoryEntry = {
    v: 1,
    account: dir.account,
    seq: dir.length,
    prev: dir.head,
    at,
    op: "add",
    member,
  };
  return sign("directory", body, signer.id, signer.signKey);
}

export function revokeEntry(
  dir: Directory,
  signer: { id: string; signKey: Uint8Array },
  id: string,
  at: string,
): SignedEnvelope {
  const body: DirectoryEntry = {
    v: 1,
    account: dir.account,
    seq: dir.length,
    prev: dir.head,
    at,
    op: "revoke",
    id,
  };
  return sign("directory", body, signer.id, signer.signKey);
}
