/**
 * The mod as a thin client of the machine's Starbridge agent (PROTOCOL.md, "Local agent API").
 *
 * Each session long-polls `GET /v1/sessions/<id>/events?wait=25` on the agent's unix socket,
 * submits each event's line into the session and confirms it with `POST /v1/sessions/<id>/ack`.
 * The agent holds the keys and the one connection to the server, so no session runs the CLI,
 * takes a lease or watches files. When no agent answers, `Switch` falls back to `Poller`, the
 * CLI-driven loop, until one does.
 */

import { configDir } from "./poller.ts";

/** The agent API revision this mod speaks, sent in the `starbridge-api` header. */
export const API = 1;
export const VERSION = "1.0.0";
const CLIENT = `starbridge-mod/${VERSION}`;

/** Event types this mod submits; others are skipped and left unconfirmed, as the API asks. */
const KNOWN = new Set(["answer"]);

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
   * Must not wait for the turn to start: a prompt submitted mid-turn waits for its own. A host
   * that can tell the submit failed returns or resolves false, and the line stays unconfirmed for
   * a later try.
   */
  submit(text: string): unknown;
  status(text: string | undefined): void;
  log(text: string): void;
}

export interface AgentTiming {
  /** Seconds the agent may hold one events request (the host aborts a call after 30 s). */
  waitSeconds: number;
  /** An events request that comes back sooner than this with nothing waits out the rest. */
  minCycleMs: number;
  /** First retry delay after an error, doubled each time up to `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
}

export const AGENT_TIMING: AgentTiming = {
  waitSeconds: 25,
  minCycleMs: 2_000,
  backoffMs: 2_000,
  maxBackoffMs: 60_000,
};

/**
 * Where the agent listens, as the CLI's `socketPath` (cli/src/agent/api.ts) works it out:
 * `$STARBRIDGE_AGENT_SOCKET`; on Windows (`OS=Windows_NT`) the port file `agent.port` in the
 * config directory; for the default config directory `$XDG_RUNTIME_DIR/starbridge/agent.sock`
 * when that is set; else `agent.sock` in the config directory.
 */
export function socketPath(env: {
  STARBRIDGE_AGENT_SOCKET?: string;
  STARBRIDGE_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  XDG_RUNTIME_DIR?: string;
  HOME?: string;
  USERPROFILE?: string;
  OS?: string;
}): string {
  if (env.STARBRIDGE_AGENT_SOCKET) return env.STARBRIDGE_AGENT_SOCKET;
  const dir = configDir(env);
  if (env.OS === "Windows_NT") return `${dir}/agent.port`;
  const standard = configDir({ ...env, STARBRIDGE_CONFIG_DIR: undefined });
  if (env.XDG_RUNTIME_DIR && dir === standard)
    return `${env.XDG_RUNTIME_DIR}/starbridge/agent.sock`;
  return `${dir}/agent.sock`;
}

/**
 * An address ending in `.port` names the file where an agent on loopback TCP wrote its port and
 * its token, which calls prove they hold without sending it (the CLI's `PortFile` and `proof`).
 */
export const isPortFile = (address: string) => address.endsWith(".port");

/** The port and the token in port file `text`; undefined when it is not one. */
export function portTarget(text: string): { port: number; token: string } | undefined {
  try {
    const f = JSON.parse(text) as { port?: unknown; token?: unknown };
    if (Number.isInteger(f.port) && typeof f.token === "string")
      return { port: f.port as number, token: f.token };
  } catch {}
  return undefined;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

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
      const r = await this.host.fetch("POST", `${path(me)}/hello`, { cwd: await this.host.cwd() });
      if (!(await this.ok(r))) return;
      this.greeted = me;
    }
    const started = await this.host.now();
    const r = await this.host.fetch("GET", `${path(me)}/events?wait=${this.t.waitSeconds}`);
    if (!(await this.ok(r))) return;
    const events = parse<{ events?: Event[] }>(r.text)?.events ?? [];
    let handed = 0;
    const done: string[] = [];
    for (const e of events) {
      if (typeof e.type !== "string" || !KNOWN.has(e.type)) continue;
      if (typeof e.ack !== "string" || typeof e.line !== "string") continue;
      // A /clear during the call made another session current: the event waits, unconfirmed,
      // until session `me` is resumed.
      if ((await this.host.sessionId()) !== me) {
        this.host.log(`starbridge: held back ${e.type} ${e.ack}: its session ${me} ended`);
        continue;
      }
      if (!this.unconfirmed.has(e.ack)) {
        if ((await this.host.submit(e.line)) === false) continue;
        this.unconfirmed.add(e.ack);
        handed++;
      }
      done.push(e.ack);
    }
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
    // 426: the agent and this mod cannot work together; the CLI's own path still can.
    if (r.status === 426) throw new Error(reason);
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
