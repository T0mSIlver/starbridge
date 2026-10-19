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
  RETENTION_DAYS,
  toB64,
  type Waiting,
} from "@starbridge/protocol";

import type { AgyRoute } from "./antigravity";
import type { CodexSession } from "./codex";
import type { PiAdded } from "./pi";
/** `$STARBRIDGE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/starbridge`, else `~/.config/starbridge`. */
export function configDir(env: Record<string, string | undefined>): string {
  if (env.STARBRIDGE_CONFIG_DIR) return env.STARBRIDGE_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "starbridge");
}

/**
 * The file `plugin/hooks/settle.sh` reads in the config folder before it starts the CLI: written
 * with the state, `open` while a permission prompt is unsettled and unexpired (#517), or a
 * question of Claude Code's picker unanswered (#848), else empty.
 */
export const PROMPTS_OPEN = "permissions-open";

/**
 * The file `plugin/hooks/prompt.sh` reads before it starts the CLI on a Claude Code prompt: the
 * sessions with a next-step card open (#2118), one per line, written with the state.
 */
export const NEXT_STEPS_OPEN = "next-steps-open";

/** What `NEXT_STEPS_OPEN` holds for state `s`. */
export function nextStepsMark(s: State): string {
  const sessions = new Set(
    Object.entries(s.asked)
      .filter(([id, a]) => a.nextStep && !a.settled && !s.answers[id])
      .map(([, a]) => a.nextStep as string),
  );
  return [...sessions].map((x) => `${x}\n`).join("");
}

/**
 * The file in the config folder that holds this CLI's absolute path, one line, for the hooks and
 * plugins that start it when their PATH lacks it (`plugin/hooks/cli.sh`, the mod; #612).
 */
export const CLI_PATH = "cli-path";

/** Claude Code's timeout for the picker's hook (plugin/hooks/hooks.json, #848). */
const PICKER_MAX_MS = 86_400_000;

/** What `PROMPTS_OPEN` holds for state `s`. */
export function promptsMark(s: State, now = Date.now()): string {
  const open =
    Object.values(s.permissions ?? {}).some(
      (p) => !p.settled && Date.parse(p.permission.expiresAt) > now,
    ) ||
    // A picker's hook ends within its day-long timeout; one that died unsettled stops counting.
    Object.entries(s.asked).some(
      ([id, a]) =>
        a.picker && !a.settled && !s.answers[id] && Date.parse(a.askedAt) > now - PICKER_MAX_MS,
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

const DAY_MS = 86_400_000;

/**
 * Drops the questions the server has forgotten, with their answers (#2017): the server deletes a
 * decision 30 days after it arrived, and a settled one 7 days after the notice (PROTOCOL.md,
 * Limits), so the text, options, answers and session titles kept here past that are history
 * nobody can read back. One still being posted, or settled with its notice owed, stays, and a question not settled stays 7 days longer for an answer that came late. An answer whose question is gone from
 * `asked` is left, since it carries no time.
 */
export function pruneState(s: State, now: number): void {
  for (const [id, a] of Object.entries(s.asked)) {
    // A settled notice not yet at the server is still owed. Otherwise a question that is not
    // settled is kept for the week the server keeps an answer after it came, on top of the month
    // it takes a question: a device may answer on day 29 and this machine fetch it on day 31.
    if (a.posting || a.unposted) continue;
    const settled = a.settled && a.settledAt;
    const kept = settled ? RETENTION_DAYS.week : RETENTION_DAYS.month + RETENTION_DAYS.week;
    const since = Date.parse(settled ? (a.settledAt as string) : a.askedAt);
    if (Number.isNaN(since) || now - since < kept * DAY_MS) continue;
    delete s.asked[id];
    delete s.answers[id];
  }
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
      /**
       * Recorded before its post returned (#1975), so an answer the server hands out meanwhile
       * counts; not re-sealed until then.
       */
      posting?: boolean;
      /** Closed with `settle`, or by `revoked`: no answer will follow. */
      settled?: boolean;
      /** Settled here, but its settled notice has not reached the server yet (#584). */
      unposted?: boolean;
      /** When `settle` closed it, and how (#1697): for what a later `wait` or `settle` says of it. */
      settledAt?: string;
      outcome?: "elsewhere" | "withdrawn";
      reason?: string;
      /**
       * Answered by a device the chain revoked since: the machine dropped that answer, and the
       * server takes no other (#515).
       */
      revoked?: boolean;
      /** The devices it was sealed to, the only ones whose answer counts. */
      to: string[];
      /**
       * The decision as signed, to re-seal it to devices that join. Its images are refs: the
       * server keeps their blobs, sealed once for every device (#685).
       */
      body?: Decision;
      /** The decision's waiting state as last posted, under the one id it keeps. */
      waiting?: { id: string; state: Waiting["state"]; at?: string };
      /**
       * The owner's latest snooze (#571): no answer before `until`. `told` once `wait` said so;
       * a newer snooze is told again.
       */
      snooze?: { until: string; at: string; told?: boolean };
      cursor?: string;
      /** The Claude Code session that asked; the mod delivers the answer there only. */
      session?: string;
      /** The subagent of that session that asked, which the mod sends the answer to (#1702). */
      subagent?: string;
      /** The asking session's title and project, for `answers --all` once `body` is gone. */
      sessionTitle?: string;
      project?: string;
      /** The Codex session that asked, which the agent queues the answer into. */
      codex?: CodexSession;
      /** The Antigravity conversation's language server, which the agent sends the answer to. */
      antigravity?: AgyRoute;
      /** Told its answer comes back as a prompt from the Pi extension or the opencode plugin. */
      extensionAnswers?: boolean;
      /**
       * Asked for a hook that waits for its answer itself: recorded without `session`, so no
       * session gets it as a prompt, and `wait` without an id skips it.
       */
      held?: boolean;
      /**
       * Asked for this Claude Code session's open `AskUserQuestion` picker (#848): settled when
       * the picker is answered there.
       */
      picker?: string;
      /**
       * Set by `hook settle` on every card of that picker, answered or not, once it closed: a
       * number the hook asks again after that is settled, not left open (#2061).
       */
      pickerClosed?: boolean;
      /**
       * Asked for the next-step box Claude desktop showed in this Claude Code session (#2118):
       * settled when the session's next prompt comes.
       */
      nextStep?: string;
    }
  >;
  /**
   * Verified answers by decision id; `seen` once a `wait` has printed it or the mod confirmed it
   * submitted it (`answers --ack`). `announce` until the settled notice that names the answer
   * reached the server, so every device learns which answer won (#330). `steering` while the
   * agent steers it into a Codex turn (#1486), when that began, in ms.
   */
  answers: Record<
    string,
    { answer: Answer; seen: boolean; device?: string; announce?: true; steering?: number }
  >;
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
  /** Setup turned systemd lingering on (#2040): uninstall turns it off again. */
  lingerEnabled?: boolean;
  /** What Starbridge added to pi-permission-system's config (#2130): uninstall takes out that. */
  piAdded?: PiAdded;
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
  /**
   * Presence (#848): the agent tells the server whether the owner sits at this machine's screen,
   * so pushes wait while they do; off unless `starbridge config presence on`.
   */
  presence?: { enabled?: boolean };
  /**
   * Agents `uninstall --agent` took Starbridge out of (#750): setup and refresh leave them
   * alone until `setup --agent` brings one back.
   */
  removedAgents?: string[];
  /** What this machine is, for its icon on devices: detected by pair and setup, or set. */
  machineKind?: MachineKind;
  /**
   * The agent's daily read of the latest release and the line saying it is out (#1050); on
   * unless `starbridge config update-check off`.
   */
  updateCheck?: { enabled?: boolean };
  /**
   * Whether the agent installs new finals on a script install by itself (#1266); on unless
   * `starbridge config updates off`.
   */
  updates?: { auto?: boolean };
  /**
   * The `codex` binary and `CODEX_HOME` setup found, the only ones the agent runs to hand a Codex
   * session its answer: a route an `ask` sends never names the binary it runs.
   */
  codex?: { bin: string; home: string };
  quota?: {
    /** The CodexBar providers to upload; none means no timer. */
    providers?: string[];
    /** A duration such as "5m". */
    interval?: string;
    /** The `codexbar` binary; default `$STARBRIDGE_CODEXBAR`, else `codexbar` on the PATH. */
    codexbar?: string;
  };
}

/** What the agent last read of GitHub's latest release (#1050), in `latest.json`. */
export interface LatestRelease {
  /** When GitHub last answered, 200 or 304. */
  checkedAt: string;
  /** The latest release, without its `v`. */
  version: string;
  /** GitHub's ETag for it: a 304 answer to it costs no request from the hourly allowance. */
  etag?: string;
}

/** Updates of this machine (#1266), in `update.json`: the agent's last try and their outcomes. */
export interface UpdateRecord {
  /** When the agent last started `starbridge update`, and the release it went for. */
  tried?: { at: string; version: string };
  /** The last update that replaced the binary, whoever ran it. */
  updated?: { at: string; from: string; to: string };
  /** The last update that failed, cleared by one that succeeds. */
  failed?: { at: string; version?: string; why: string };
}

/**
 * The format of every file in the config folder, written as `v` (#473). A file without `v` is
 * version 1, the format 0.1.0 shipped; a later format raises it and reads the ones before.
 */
const STATE_VERSION = 1;

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
          ? "is not in this starbridge's format: remove it, the server's copy is read again"
          : "is not in this starbridge's format: move it away, then run `starbridge pair`",
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

  /**
   * Saves the machine `STARBRIDGE_MACHINE` carries when this folder holds none (#1818), as a
   * cloud session's fresh container does. A folder that holds a machine keeps it.
   */
  seedMachine(exported: string) {
    if (existsSync(this.path("machine.json"))) return;
    const m = importMachine(exported);
    this.locked(() => {
      if (existsSync(this.path("machine.json"))) return;
      this.saveMachine(m);
      if (!existsSync(this.path("agent.json"))) this.saveAgentConfig({ machineKind: "cloud" });
    });
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

  /** The agent's last read of the latest release (#1050). */
  latest(): LatestRelease | undefined {
    return this.read<LatestRelease>("latest.json");
  }

  /**
   * Moves an unreadable `latest.json` to `latest.json.unreadable-<time>` (#1174): it is only a
   * cache of GitHub's answer, so the next read starts over rather than stopping the check.
   */
  setLatestAside(now: Date) {
    const p = this.path("latest.json");
    renameSync(p, `${p}.unreadable-${now.toISOString().replace(/[:.]/g, "-")}`);
  }

  saveLatest(l: LatestRelease) {
    this.write("latest.json", l);
  }

  /** Updates of this machine (#1266). */
  updates(): UpdateRecord {
    return this.read<UpdateRecord>("update.json") ?? {};
  }

  /** Re-reads `update.json`, applies `fn` and writes it back, under the lock. */
  recordUpdate(fn: (r: UpdateRecord) => void) {
    this.locked(() => {
      let r: UpdateRecord = {};
      try {
        r = this.updates();
      } catch {
        // Only a record: an unreadable one starts over.
      }
      fn(r);
      this.write("update.json", r);
    });
  }

  /** Re-reads the state, applies `fn` and writes it back, under the lock. */
  updateState(fn: (s: State) => void): State {
    return this.locked(() => {
      const s = this.state();
      fn(s);
      pruneState(s, Date.now());
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
    const steps = nextStepsMark(s);
    let was: string | undefined;
    try {
      was = readFileSync(this.path(NEXT_STEPS_OPEN), "utf8");
    } catch {}
    // Written once a card was asked for a box, and kept in step after.
    if (was !== undefined ? was !== steps : steps !== "")
      writeFileSync(this.path(NEXT_STEPS_OPEN), steps, { mode: 0o600 });
  }
}

/** The start of `starbridge machine export`'s line, which names its format (#1818). */
const EXPORT_PREFIX = "sbm1.";

/** `STARBRIDGE_MACHINE` holds something `starbridge machine export` did not print. */
export class MachineEnvError extends Error {
  constructor(why: string) {
    super(`STARBRIDGE_MACHINE is not a line \`starbridge machine export\` printed: ${why}`);
  }
}

/** This machine's identity as one line, for a cloud environment's `STARBRIDGE_MACHINE` (#1818). */
export function exportMachine(m: Machine): string {
  const { server, account, id, name, token, keys, pin } = m;
  const json = JSON.stringify({ server, account, id, name, token, keys, pin });
  return EXPORT_PREFIX + toB64(new TextEncoder().encode(json));
}

/** Reads `exportMachine`'s line back, checking each field's type and each key's length. */
function importMachine(line: string): Machine {
  const text = line.trim();
  if (!text.startsWith(EXPORT_PREFIX))
    throw new MachineEnvError(`it does not start with ${EXPORT_PREFIX}`);
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(new TextDecoder().decode(fromB64(text.slice(EXPORT_PREFIX.length))));
  } catch {
    throw new MachineEnvError("it does not decode");
  }
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  if (
    typeof m !== "object" ||
    m === null ||
    !["server", "account", "id", "name", "token"].every((k) => str(m[k]))
  )
    throw new MachineEnvError("a field is missing");
  if (!/^https?:\/\//.test(m.server as string))
    throw new MachineEnvError("its server is no http(s) URL");
  const keys = m.keys as Record<string, unknown> | null;
  const lengths = { boxPk: 32, boxSk: 32, signPk: 32, signSk: 64 } as const;
  for (const [k, n] of Object.entries(lengths)) {
    let ok = false;
    try {
      ok = typeof keys?.[k] === "string" && fromB64(keys[k] as string).length === n;
    } catch {}
    if (!ok) throw new MachineEnvError(`its ${k} key is not ${n} bytes`);
  }
  const pin = m.pin as Record<string, unknown> | null;
  if (!Number.isSafeInteger(pin?.length) || (pin?.length as number) < 1 || !str(pin?.head))
    throw new MachineEnvError("its directory pin is missing");
  return {
    server: m.server as string,
    account: m.account as string,
    id: m.id as string,
    name: m.name as string,
    token: m.token as string,
    keys: {
      boxPk: keys?.boxPk as string,
      boxSk: keys?.boxSk as string,
      signPk: keys?.signPk as string,
      signSk: keys?.signSk as string,
    },
    pin: { length: pin?.length as number, head: pin?.head as string },
  };
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

/** `STARBRIDGE_MACHINE` carries `machine`, rather than the folder holding another one (#1838). */
export function carries(line: string | undefined, machine: Machine): boolean {
  if (!line) return false;
  try {
    return importMachine(line).id === machine.id;
  } catch {
    return false;
  }
}
