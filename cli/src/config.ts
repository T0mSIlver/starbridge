import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Answer,
  type Decision,
  fromB64,
  type MachineKind,
  type MemberKeys,
  type Permission,
  type PermissionAnswer,
  type Pin,
  type QuotaWindow,
  toB64,
  type Waiting,
} from "@starbridge/protocol";

import type { CodexSession } from "./codex";
/** `$STARBRIDGE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/starbridge`, else `~/.config/starbridge`. */
export function configDir(env: Record<string, string | undefined>): string {
  if (env.STARBRIDGE_CONFIG_DIR) return env.STARBRIDGE_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "starbridge");
}

/**
 * The file `plugin/hooks/settle.sh` reads in the config folder before it starts the CLI: written
 * with the state, `open` while a permission prompt is unsettled and unexpired, else empty (#517).
 * Missing, the CLI is older or has not written since: the hook starts it.
 */
export const PROMPTS_OPEN = "permissions-open";

/** What `PROMPTS_OPEN` holds for state `s`. */
export function promptsMark(s: State, now = Date.now()): string {
  const open = Object.values(s.permissions ?? {}).some(
    (p) => !p.settled && Date.parse(p.permission.expiresAt) > now,
  );
  return open ? "open" : "";
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
      /** Answered on its `answerIn` page instead of Starbridge. */
      answerIn?: boolean;
      /** With `answerIn`: takes a Done answer from a device (#539). */
      done?: boolean;
      /** Closed with `settle`, or by `revoked`: no answer will follow. */
      settled?: boolean;
      /**
       * Answered by a device the chain revoked since: the machine dropped that answer, and the
       * server takes no other (#515).
       */
      revoked?: boolean;
      /** The devices it was sealed to, the only ones whose answer counts. */
      to?: string[];
      /** The decision as signed, without its images, to re-seal it to devices that join. */
      body?: Omit<Decision, "images">;
      /** Its image files, read again when it is re-sealed. */
      images?: (string | { path: string; alt?: string })[];
      /** The decision's waiting state as last posted, under the one id it keeps. */
      waiting?: { id: string; state: Waiting["state"] };
      /**
       * The owner's latest snooze (#571): no answer before `until`. `told` once `wait` said so;
       * a newer snooze is told again.
       */
      snooze?: { until: string; at: string; told?: boolean };
      cursor?: string;
      /** The Claude Code session that asked; the mod delivers the answer there only. */
      session?: string;
      /** The Codex session that asked, which the agent queues the answer into. */
      codex?: CodexSession;
      /** Told its answer comes back as a prompt from the Pi extension or the opencode plugin. */
      extensionAnswers?: boolean;
      /**
       * Asked for a hook that waits for its answer itself: recorded without `session`, so no
       * session gets it as a prompt, and `wait` without an id skips it.
       */
      held?: boolean;
    }
  >;
  /**
   * Verified answers by decision id; `seen` once a `wait` has printed it or the mod confirmed it
   * submitted it (`answers --ack`). `announce` until the settled notice that names the answer
   * reached the server, so every device learns which answer won (#330).
   */
  answers: Record<string, { answer: Answer; seen: boolean; device?: string; announce?: true }>;
  /**
   * The longest directory head each device signed into an answer: while a device active in the
   * machine's chain signed one that chain lacks, the server is withholding entries (PROTOCOL.md,
   * Directory) and no answer counts.
   */
  heads?: Record<string, Pin>;
  /** Set while it does: why. No answer is accepted or delivered meanwhile. */
  behind?: string;
  /** Signed answers that came while the directory was behind, checked again once it is not. */
  held?: unknown[];
  /** Permission prompts this machine posted (#57), by id, until a day after they expire. */
  permissions?: Record<string, PendingPermission>;
  /** Quota alerts already raised, by `alertKey`: the reset of the cycle they were raised in. */
  alerts?: Record<string, string>;
  /** Each provider's last windows read without an error, and when, for the rounds CodexBar fails. */
  quotas?: Record<string, LastQuota>;
}

export interface LastQuota {
  at: string;
  account?: string;
  windows: QuotaWindow[];
}

/**
 * An `addRules` or `addDirectories` update Claude Code offered with a prompt (the SDK's
 * `PermissionUpdate`); the hook returns it with the destination of the chosen scope.
 */
export interface PermissionUpdate {
  type: "addRules" | "addDirectories";
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: string;
  directories?: string[];
  destination?: string;
}

/** A permission prompt as the machine keeps it while a hook waits on it. */
export interface PendingPermission {
  /** The body as signed and posted; `to` also names devices it was re-sealed to (#340). */
  permission: Permission;
  /** The devices of its last re-seal the server took; until one, `permission.to`. */
  sealedTo?: string[];
  /** The Claude Code session that asked. */
  session: string;
  /** The updates behind the offered scopes; an allow for a wider scope writes these. */
  updates: PermissionUpdate[];
  /** The answers cursor when it was posted: a wait from there cannot miss its answer. */
  cursor?: string;
  /** The device's answer, once accepted. */
  answer?: PermissionAnswer & { device: string };
  /** Set once the prompt ended; nothing is accepted after. */
  settled?: "keyboard" | "timeout" | "device";
}

/**
 * `agent.json`: what `starbridge agent` runs with, written by `starbridge setup`; the agent's
 * flags override it.
 */
export interface AgentConfig {
  /** Permission prompts go to Starbridge (#57); off unless `starbridge config permissions on`. */
  permissions?: { enabled?: boolean };
  /** What this machine is, for its icon on devices: detected by pair and setup, or set. */
  machineKind?: MachineKind;
  quota?: {
    /** The CodexBar providers to upload; none means no timer. */
    providers?: string[];
    /** A duration such as "5m". */
    interval?: string;
    /** The `codexbar` binary; default `$STARBRIDGE_CODEXBAR`, else `codexbar` on the PATH. */
    codexbar?: string;
  };
}

/**
 * The format of every file in the config folder, written as `v` (#473). A file without `v` is
 * version 1, the format 0.1.0 shipped; a later format raises it and reads the ones before.
 */
export const STATE_VERSION = 1;

/** A file this CLI cannot read. It stays as it is: nothing overwrites it with defaults. */
export class StateFileError extends Error {
  constructor(path: string, why: string) {
    super(`${path} ${why}; it is left as it is`);
  }
}

/** Every holder lets go within milliseconds; this long means a lock nobody can break. */
const LOCK_TIMEOUT_MS = 15_000;
const tick = new Int32Array(new SharedArrayBuffer(4));

function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether the process that wrote lock text `held` ("<pid> <nonce>") still runs. */
function alive(held: string): boolean {
  const pid = Number(held.split(" ")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
    const mine = `${process.pid} ${randomBytes(8).toString("hex")}`;
    const end = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      this.breakDeadLock(lock);
      if (Date.now() > end)
        throw new Error(`${lock} stays locked: remove it if no starbridge runs`);
      Atomics.wait(tick, 0, 0, 5);
    }
    try {
      return fn();
    } finally {
      // Another process may have broken it as dead; never remove a lock that is not ours.
      if (readLock(lock) === mine) unlinkSync(lock);
    }
  }

  /**
   * Removes a lock whose process is gone. It moves the lock aside first and removes it only if
   * it is still the dead one, so two processes breaking it at once do not remove a lock a third
   * just took; a live one moved aside by mistake goes back.
   */
  private breakDeadLock(lock: string) {
    const held = readLock(lock);
    if (held === undefined || alive(held)) return;
    const aside = `${lock}.${process.pid}`;
    try {
      renameSync(lock, aside);
    } catch {
      return;
    }
    if (readLock(aside) === held) {
      unlinkSync(aside);
      return;
    }
    try {
      linkSync(aside, lock);
    } catch {
      // A third process took the lock in the instant the live one was aside: both now run,
      // which needs a crashed holder and three contenders within microseconds.
    }
    unlinkSync(aside);
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  private read<T>(name: string): T | undefined {
    const p = this.path(name);
    if (!existsSync(p)) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new StateFileError(p, `is not valid JSON (${(e as Error).message}): fix or remove it`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new StateFileError(
        p,
        name === "directory.json"
          ? "is not in this starbridge's format (from before the first release?): remove it, the server's copy is read again"
          : "is not in this starbridge's format (from before the first release?): move it away, then run `starbridge pair`",
      );
    const v = (value as { v?: unknown }).v ?? 1;
    if (v !== STATE_VERSION)
      throw new StateFileError(p, `has format ${v}, from a newer starbridge: update starbridge`);
    const { v: _, ...rest } = value as Record<string, unknown>;
    return rest as T;
  }

  /** Writes through a temporary file, so a crash or a concurrent reader never sees half a file. */
  private write(name: string, value: unknown) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = this.path(`.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify({ v: STATE_VERSION, ...(value as object) }, null, 2)}\n`, {
      mode: 0o600,
    });
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
    return this.read<{ entries: unknown[] }>("directory.json")?.entries ?? [];
  }

  saveDirectory(entries: unknown[]) {
    this.write("directory.json", { entries });
  }

  agentConfig(): AgentConfig {
    return this.read<AgentConfig>("agent.json") ?? {};
  }

  saveAgentConfig(c: AgentConfig) {
    this.write("agent.json", c);
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
      this.markPromptsOpen(s);
      return s;
    });
  }

  /**
   * Keeps `PROMPTS_OPEN` in step with the state: non-empty exactly while a permission prompt is
   * open, so the Claude Code plugin's `PostToolUse` hook starts `starbridge hook settle` only
   * then (#517).
   */
  /**
   * Whether `PROMPTS_OPEN` disagrees with the saved state `s`, missing or stale, so an update
   * would fix it. False without a saved state, which an update would create.
   */
  promptsMarkStale(s: State): boolean {
    return existsSync(this.path("state.json")) && this.readMark() !== promptsMark(s);
  }

  private readMark(): string | undefined {
    try {
      return readFileSync(this.path(PROMPTS_OPEN), "utf8");
    } catch {
      return undefined;
    }
  }

  private markPromptsOpen(s: State) {
    const mark = promptsMark(s);
    if (this.readMark() !== mark) writeFileSync(this.path(PROMPTS_OPEN), mark, { mode: 0o600 });
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
