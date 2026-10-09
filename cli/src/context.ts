import {
  activeMembers,
  type Directory,
  type DirectoryHead,
  type MachineKind,
  type Member,
  type MemberKeys,
  verifyDirectory,
  withheldBy,
} from "@starbridge/protocol";
import { Api, REMOVED } from "./api";
import { decodeKeys, type Machine, type State, type Store } from "./config";

/** Everything a command touches outside its arguments, so tests can run commands in-process. */
export interface Ctx {
  env: Record<string, string | undefined>;
  store: Store;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Aborts long waits on Ctrl-C. */
  signal?: AbortSignal;
}

/** `{machineKind}` for an item's source, when setup detected it or `config` set it. */
export function machineKind(ctx: Ctx): { machineKind?: MachineKind } {
  const kind = ctx.store.agentConfig().machineKind;
  return kind ? { machineKind: kind } : {};
}

/** A mistake the user can fix: printed without a stack, exit code 1. */
export class UsageError extends Error {}

/** The server holds back directory entries: nothing is sent until it serves them (#794). */
export class WithheldError extends UsageError {}

export interface Session {
  machine: Machine;
  keys: MemberKeys;
  api: Api;
}

export function session(ctx: Ctx): Session {
  const machine = ctx.store.machine();
  if (!machine) throw new UsageError("this machine is not paired: run `starbridge pair` first");
  return { machine, keys: decodeKeys(machine.keys), api: new Api(machine.server, machine.token) };
}

/**
 * Fetches the directory entries added since the last call and verifies the whole chain against
 * the pin, so the server can neither add a key nor roll back a revocation. Then moves the pin.
 * Another process may have moved it meanwhile from a longer fetch: under the lock, the longer
 * chain wins, and each must extend the other's pin.
 */
export async function refreshDirectory(
  ctx: Ctx,
  s: Session,
  signal?: AbortSignal,
): Promise<Directory> {
  const account = s.machine.account;
  const cached = ctx.store.directory();
  const fresh = await s.api.directory(cached.length, signal);
  const entries = [...cached, ...fresh];
  const ours = verifyDirectory(entries, { account, pin: s.machine.pin });
  const dir = ctx.store.locked(() => {
    const machine = ctx.store.machine();
    if (machine?.id !== s.machine.id || machine.account !== account)
      throw new UsageError("this machine was paired again meanwhile: run the command again");
    const saved = ctx.store.directory();
    if (saved.length >= ours.length) {
      verifyDirectory(saved, { account, pin: { length: ours.length, head: ours.head } });
      s.machine = machine;
      return saved.length === ours.length
        ? ours
        : verifyDirectory(saved, { account, pin: machine.pin });
    }
    verifyDirectory(entries, { account, pin: machine.pin });
    ctx.store.saveDirectory(entries);
    s.machine = { ...machine, pin: { length: ours.length, head: ours.head } };
    ctx.store.saveMachine(s.machine);
    return ours;
  });
  const me = dir.members.get(s.machine.id);
  if (!me?.active) throw new UsageError(REMOVED);
  return dir;
}

/**
 * The head this machine signs into its items, so a device served a shorter chain sees what the
 * server holds back from it (#362). A machine that knows of a longer one posts nothing (#794).
 */
export function signedHead(dir: Directory): DirectoryHead {
  return { length: dir.length, head: dir.head };
}

/**
 * Whether a device signed a head the machine's chain `entries` lacks, and why that holds. Either
 * the server is holding back entries, perhaps the revocation of a device in `dir`; or a `revoke`
 * entry names that device. A device signs no head past its own revocation, so that chain forks
 * from the one the device saw: a revoked device can extend a stale chain and revoke the device
 * that revoked it (#794). Only a `recover`, which no device signs, or pairing again ends that
 * hold. Says which, or undefined.
 */
export function withheld(st: State, dir: Directory, entries: unknown[]): string | undefined {
  const held = withheldBy(st.heads ?? {}, dir, entries);
  if (!held) return undefined;
  if (held.revoked)
    return `${held.id} signed a chain this machine does not hold (${held.head.length}), and this machine's chain revokes it: the server may be serving a fork. If you revoked ${held.id} because it was compromised, run \`starbridge pair --force\``;
  return `the server is holding back directory entries ${held.id} has seen (${held.head.length}, this machine has ${dir.length})`;
}

/**
 * The devices a new item is sealed to. None while the server is known to hold back entries of
 * `dir`, since one of them may revoke a device in it (#794). Checked against `dir`'s own
 * entries: a longer chain another process stored since holds heads that `dir` lacks.
 */
export function devices(ctx: Ctx, dir: Directory): Member[] {
  const behind = withheld(ctx.store.state(), dir, ctx.store.directory().slice(0, dir.length));
  if (behind) throw new WithheldError(`${behind}. Nothing is sent meanwhile`);
  const list = activeMembers(dir, "device");
  if (list.length === 0) throw new UsageError("the directory has no active device to send to");
  return list;
}

/** "90s", "30m", "2h", "1d", or a number of seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(text.trim());
  if (!m) throw new UsageError(`not a duration: ${text} (try 30m, 2h, 1d)`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s") as "s"];
  return Number(m[1]) * unit * 1000;
}

/** ISO 8601 in UTC, whole seconds. */
export const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
