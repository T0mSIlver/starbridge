import {
  activeMembers,
  type Directory,
  type Member,
  type MemberKeys,
  verifyDirectory,
} from "@starbridge/protocol";
import { Api } from "./api";
import { decodeKeys, type Machine, type Store } from "./config";

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

/** A mistake the user can fix: printed without a stack, exit code 1. */
export class UsageError extends Error {}

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
export async function refreshDirectory(ctx: Ctx, s: Session): Promise<Directory> {
  const account = s.machine.account;
  const cached = ctx.store.directory();
  const fresh = await s.api.directory(cached.length);
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
  if (!me?.active) throw new UsageError("this machine was revoked: run `starbridge pair` again");
  return dir;
}

export function devices(dir: Directory): Member[] {
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
