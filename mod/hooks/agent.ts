/**
 * The mod as a thin client of the machine's Starbridge agent (PROTOCOL.md, "Local agent API").
 *
 * Each session long-polls `GET /v1/sessions/<id>/events?wait=25` on the agent's unix socket,
 * submits each event's line into the session and confirms it with `POST /v1/sessions/<id>/ack`.
 * The agent holds the keys and the one connection to the server, so no session runs the CLI,
 * takes a lease or watches files. When no agent answers, `Switch` falls back to `Poller`, the
 * CLI-driven loop, until one does.
 */

import {
  agentSocket,
  CONFIG_HEADER,
  isPortFile,
  portTarget,
  configKey as sharedConfigKey,
} from "./address.ts";
import { configDir } from "./poller.ts";

/** The agent API revision this mod speaks, sent in the `starbridge-api` header. */
export const API = 1;
export const VERSION = "0.1.8-rc.5";
const CLIENT = `starbridge-mod/${VERSION}`;

/** Event types this mod submits; others are skipped and left unconfirmed, as the API asks. */
const KNOWN = new Set(["answer"]);

/** An answer's line, and what confirms it. */
export interface Line {
  text: string;
  ack: string;
  /** The Claude Code subagent that asked, which gets the line instead of the session (#1702). */
  subagent?: string;
}

/** Several answers as one message: one line each, in the order they came. */
export const joinLines = (lines: Line[]) => lines.map((l) => l.text).join("\n");

export interface Reply {
  status: number;
  text: string;
}

export interface AgentHost {
  /** The session's id now; a `/clear` changes it. */
  sessionId(): Promise<string>;
  cwd(): Promise<string>;
  /** One HTTP call on the agent's socket. Rejects when it cannot connect or the host aborts it. */
  fetch(method: string, path: string, body?: unknown): Promise<Reply>;
  now(): Promise<number>;
  sleep(ms: number): Promise<void>;
  /**
   * Submits `lines`, every answer one poll brought, as one message (#1597), and returns the acks
   * of those it submitted; a line it could not submit, or holds back for now, stays unconfirmed
   * for a later try. Must not wait for the turn to start: a prompt submitted mid-turn waits for
   * its own.
   */
  submit(lines: Line[]): string[] | Promise<string[]>;
  /**
   * True while a submitted prompt waits for its turn. Claude Code starts a plugin's queued prompt
   * only once the mod's open `fetch` or `run` returns, so the loop then holds no long call (#1446).
   */
  starting(): boolean;
  status(text: string | undefined): void;
  log(text: string): void;
}

export interface AgentTiming {
  /** Seconds the agent may hold one events request (the host aborts a call after 30 s). */
  waitSeconds: number;
  /**
   * An events request that comes back sooner than this with nothing waits out the rest; while a
   * prompt waits for its turn, requests don't wait and this is the time between them.
   */
  minCycleMs: number;
  /** First retry delay after an error, doubled each time up to `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
}

const AGENT_TIMING: AgentTiming = {
  waitSeconds: 25,
  minCycleMs: 2_000,
  backoffMs: 2_000,
  maxBackoffMs: 60_000,
};

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The `configKey` of config folder `dir` (address.ts), hashed with WebCrypto, the one SHA-256 the
 * mod's host offers. Sent as `CONFIG_HEADER`, so an agent of another config folder refuses the
 * call (#1966).
 */
export function configKey(dir: string, windows = false): Promise<string> {
  return sharedConfigKey(dir, windows, async (text) =>
    hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))),
  );
}

export { CONFIG_HEADER, isPortFile, portTarget };

/**
 * Where the agent listens (`agentSocket` in address.ts), with the config folder from `$HOME`
 * (`configDir`). `config` is the key to send, undefined when `$STARBRIDGE_AGENT_SOCKET` names
 * the agent.
 */
export async function agentAddress(env: {
  STARBRIDGE_AGENT_SOCKET?: string;
  STARBRIDGE_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  XDG_RUNTIME_DIR?: string;
  HOME?: string;
  USERPROFILE?: string;
  OS?: string;
}): Promise<{ socket: string; config?: string }> {
  if (env.STARBRIDGE_AGENT_SOCKET) return { socket: env.STARBRIDGE_AGENT_SOCKET };
  const windows = env.OS === "Windows_NT";
  const path = configDir(env);
  const config = await configKey(path, windows);
  const standard = configDir({ ...env, STARBRIDGE_CONFIG_DIR: undefined });
  const join = (...parts: string[]) => parts.join("/");
  return { socket: agentSocket(env, { path, standard, key: config }, windows, join), config };
}

/**
 * Whether process `pid` runs, for a host that can run commands but not signal a process:
 * `tasklist` on Windows, `ps` elsewhere. A call sends nothing to a port whose agent's pid runs no
 * more, as the CLI does (#570): a dead agent's port shows in `netstat` to every local user, and
 * whoever takes it would get the call's body before failing its proof. A check that cannot run
 * counts as not running, so the mod falls back to the CLI.
 */
export async function pidRuns(
  pid: number,
  windows: boolean,
  run: (argv: string[]) => Promise<{ exitCode: number | null; stdout: string }>,
): Promise<boolean> {
  try {
    if (windows) {
      // One CSV row per match, `"image","pid",…`; with none, a message in the system's language.
      const r = await run(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      return r.exitCode === 0 && new RegExp(`^"[^"]*","${pid}",`, "m").test(r.stdout);
    }
    const r = await run(["ps", "-p", String(pid), "-o", "pid="]);
    return r.exitCode === 0 && r.stdout.trim() === String(pid);
  } catch {
    return false;
  }
}

async function proof(token: string, role: "client" | "agent", nonce: string): Promise<string> {
  const data = new TextEncoder().encode(`${token}:${role}:${nonce}`);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/**
 * The headers that prove a call holds `token`, and the `starbridge-proof` header the agent's
 * answer must carry: anything that answers without it took the port of an agent that stopped.
 */
export async function signCall(token: string): Promise<{
  headers: Record<string, string>;
  expect: string;
}> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  return {
    headers: {
      "starbridge-nonce": nonce,
      authorization: `Starbridge ${await proof(token, "client", nonce)}`,
    },
    expect: await proof(token, "agent", nonce),
  };
}

export const PROOF_HEADER = "starbridge-proof";

/** The headers every call carries. */
export const HEADERS: Record<string, string> = {
  "starbridge-api": String(API),
  "user-agent": CLIENT,
};

interface Event {
  type?: unknown;
  ack?: unknown;
  line?: unknown;
  decisionId?: unknown;
  subagent?: unknown;
}

/** Why `AgentLoop.run` returned: `stop`, or the agent cannot serve this mod. */
export type Ended = "stopped" | "unreachable";

export class AgentLoop {
  private stopped = false;
  private failures = 0;
  /** The session id `hello` last went out under. */
  private greeted: string | undefined;

  constructor(
    private readonly host: AgentHost,
    /** Lines submitted but not yet confirmed, shared with `Poller` so a switch submits nothing twice. */
    private readonly unconfirmed: Set<string>,
    private readonly t: AgentTiming = AGENT_TIMING,
  ) {}

  /** Ends the loop after the current step. */
  stop() {
    this.stopped = true;
  }

  /** Runs until `stop`, or until a call cannot reach the agent or gets a 426. */
  async run(): Promise<Ended> {
    while (!this.stopped) {
      try {
        await this.step();
      } catch (e) {
        // A call that never connected, one the host aborted (the agent is gone or hung), or a
        // 426 (it speaks another API revision).
        this.host.log(`starbridge: agent unreachable: ${(e as Error).message}`);
        return "unreachable";
      }
    }
    return "stopped";
  }

  /**
   * Confirms the events among `acks` that the agent still hands this session, and returns those:
   * a line a `wait` or `waiting` printed meanwhile is not handed over again (#1484).
   */
  async claim(acks: string[]): Promise<string[]> {
    const me = await this.host.sessionId();
    const r = await this.host.fetch("GET", `${path(me)}/events?wait=0`);
    if (r.status < 200 || r.status >= 300) return [];
    const pending = new Set((parse<{ events?: Event[] }>(r.text)?.events ?? []).map((e) => e.ack));
    const mine = acks.filter((a) => pending.has(a));
    if (mine.length === 0) return [];
    const ack = await this.host.fetch("POST", `${path(me)}/ack`, { acks: mine });
    if (ack.status < 200 || ack.status >= 300) return [];
    // What it confirmed now: not a line a `wait` or `waiting` took since the read. An agent older
    // than that names none.
    return parse<{ acked?: string[] }>(ack.text)?.acked ?? mine;
  }

  /** Tells the agent the session ended, so its session-scoped state goes. */
  async bye(): Promise<void> {
    const me = this.greeted;
    if (!me) return;
    await this.host.fetch("POST", `${path(me)}/bye`).catch(() => undefined);
  }

  private async step() {
    const me = await this.host.sessionId();
    if (!me) {
      await this.host.sleep(this.t.minCycleMs);
      return;
    }
    if (this.greeted !== me) {
      // After a /clear: the old id has no mod any more (#537).
      const replaces = this.greeted ? { replaces: this.greeted } : {};
      const r = await this.host.fetch("POST", `${path(me)}/hello`, {
        cwd: await this.host.cwd(),
        ...replaces,
      });
      if (!(await this.ok(r))) return;
      this.greeted = me;
    }
    const started = await this.host.now();
    const wait = this.host.starting() ? 0 : this.t.waitSeconds;
    const r = await this.host.fetch("GET", `${path(me)}/events?wait=${wait}`);
    if (!(await this.ok(r))) return;
    const events = (parse<{ events?: Event[] }>(r.text)?.events ?? []).filter(
      (e): e is Event & { ack: string; line: string } =>
        typeof e.type === "string" &&
        KNOWN.has(e.type) &&
        typeof e.ack === "string" &&
        typeof e.line === "string",
    );
    // A /clear during the call made another session current: the events wait, unconfirmed,
    // until session `me` is resumed.
    if (events.length > 0 && (await this.host.sessionId()) !== me) {
      this.host.log(
        `starbridge: held back the answers ${events.map((l) => l.ack).join(", ")}: their session ${me} ended`,
      );
      return;
    }
    const due = events.filter((e) => !this.unconfirmed.has(e.ack));
    const taken =
      due.length > 0
        ? await this.host.submit(
            due.map((e) => ({
              text: e.line,
              ack: e.ack,
              ...(typeof e.subagent === "string" ? { subagent: e.subagent } : {}),
            })),
          )
        : [];
    for (const a of taken) this.unconfirmed.add(a);
    const handed = taken.length;
    const done = events.filter((e) => this.unconfirmed.has(e.ack)).map((e) => e.ack);
    if (done.length > 0) {
      const ack = await this.host.fetch("POST", `${path(me)}/ack`, { acks: done });
      if (!(await this.ok(ack))) return;
      for (const a of done) this.unconfirmed.delete(a);
    }
    const left = started + this.t.minCycleMs - (await this.host.now());
    if (handed === 0 && left > 0) await this.host.sleep(left);
  }

  /** True on a 2xx; otherwise shows the agent's reason and waits before the next try. */
  private async ok(r: Reply): Promise<boolean> {
    if (r.status >= 200 && r.status < 300) {
      if (this.failures > 0) this.host.status(undefined);
      this.failures = 0;
      return true;
    }
    const body = parse<{ error?: string; detail?: string }>(r.text);
    const reason = body?.detail ?? body?.error ?? `status ${r.status}`;
    // 426: the agent and this mod cannot work together; 421: it serves another config folder
    // (#1966). The CLI's own path still can.
    if (r.status === 426 || r.status === 421) throw new Error(reason);
    this.failures++;
    const delay = Math.min(this.t.maxBackoffMs, this.t.backoffMs * 2 ** (this.failures - 1));
    const text = `starbridge: ${reason}`;
    this.host.status(text);
    this.host.log(`${text}; retrying in ${Math.round(delay / 1000)} s`);
    await this.host.sleep(delay);
    return false;
  }
}

function path(session: string): string {
  return `/v1/sessions/${encodeURIComponent(session)}`;
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
