import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Answer, fromB64, type MemberKeys, type Pin, toB64 } from "@starbridge/protocol";

/** `$STARBRIDGE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/starbridge`, else `~/.config/starbridge`. */
export function configDir(env: Record<string, string | undefined>): string {
  if (env.STARBRIDGE_CONFIG_DIR) return env.STARBRIDGE_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "starbridge");
}

/** This machine's identity. Holds the private keys and the machine token: mode 0600. */
export interface Machine {
  server: string;
  account: string;
  id: string;
  name: string;
  token: string;
  keys: { boxPk: string; boxSk: string; signPk: string; signSk: string };
  /** The directory as last verified; a later fetch must extend it. */
  pin: Pin;
}

/** What `ask` and `wait` share across processes. */
export interface State {
  /** Where the last `wait` for any answer stopped. */
  cursor?: string;
  asked: Record<
    string,
    {
      question: string;
      options: string[];
      askedAt: string;
      defaultAt?: string;
      cursor?: string;
      /** The Claude Code session that asked; the mod delivers the answer there only. */
      session?: string;
    }
  >;
  /**
   * Verified answers by decision id; `seen` once a `wait` has printed it or the mod confirmed it
   * submitted it (`answers --ack`).
   */
  answers: Record<string, { answer: Answer; seen: boolean }>;
}

/** A lock older than this was left by a crashed process: every holder lets go within milliseconds. */
const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;
const tick = new Int32Array(new SharedArrayBuffer(4));

export class Store {
  constructor(readonly dir: string) {}

  /**
   * Runs `fn` while holding `.lock`, which one process at a time can create, so read-modify-write
   * cycles from several CLI processes (the mod's poll, an agent's `ask`) do not undo each other.
   * `fn` must not await, nor take the lock again: the lock is released when it returns.
   */
  locked<T>(fn: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = this.path(".lock");
    const end = Date.now() + LOCK_TIMEOUT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lock, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
        } catch {
          // Released meanwhile.
        }
        if (Date.now() > end)
          throw new Error(`${lock} stays locked: remove it if no starbridge runs`);
        Atomics.wait(tick, 0, 0, 5);
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  private read<T>(name: string): T | undefined {
    const p = this.path(name);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  }

  /** Writes through a temporary file, so a crash or a concurrent reader never sees half a file. */
  private write(name: string, value: unknown) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = this.path(`.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path(name));
  }

  machine(): Machine | undefined {
    return this.read<Machine>("machine.json");
  }

  saveMachine(m: Machine) {
    this.write("machine.json", m);
  }

  directory(): unknown[] {
    return this.read<unknown[]>("directory.json") ?? [];
  }

  saveDirectory(entries: unknown[]) {
    this.write("directory.json", entries);
  }

  state(): State {
    return this.read<State>("state.json") ?? { asked: {}, answers: {} };
  }

  /** Re-reads the state, applies `fn` and writes it back, under the lock. */
  updateState(fn: (s: State) => void): State {
    return this.locked(() => {
      const s = this.state();
      fn(s);
      this.write("state.json", s);
      return s;
    });
  }
}

export function encodeKeys(k: MemberKeys): Machine["keys"] {
  return {
    boxPk: toB64(k.box.publicKey),
    boxSk: toB64(k.box.privateKey),
    signPk: toB64(k.sign.publicKey),
    signSk: toB64(k.sign.privateKey),
  };
}

export function decodeKeys(k: Machine["keys"]): MemberKeys {
  return {
    box: { publicKey: fromB64(k.boxPk), privateKey: fromB64(k.boxSk) },
    sign: { publicKey: fromB64(k.signPk), privateKey: fromB64(k.signSk) },
  };
}
