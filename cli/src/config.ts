import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** Verified answers by decision id; `seen` once a `wait` has printed it. */
  answers: Record<string, { answer: Answer; seen: boolean }>;
}

export class Store {
  constructor(readonly dir: string) {}

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

  /** Re-reads the state, applies `fn` and writes it back, to narrow races between processes. */
  updateState(fn: (s: State) => void): State {
    const s = this.state();
    fn(s);
    this.write("state.json", s);
    return s;
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
