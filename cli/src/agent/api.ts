/**
 * The local agent's API: HTTP with JSON bodies over a unix socket, or loopback TCP on Windows
 * (`PortFile`), for the CLI and the Claude Code mod on the same machine (PROTOCOL.md, "Local
 * agent API"). Both sides import this file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config";

/**
 * The API revision a client speaks, sent in the `starbridge-api` header. The agent serves
 * MIN_API to API; outside that range it answers 426 with what to update. Adding a route or a
 * field keeps the number; changing or removing one bumps it.
 */
export const API = 1;
export const MIN_API = 1;
export const API_HEADER = "starbridge-api";

/** Longest `wait` the agent holds a request: under the 30 s the mod's host allows a call. */
export const MAX_HOLD_SECONDS = 25;

/**
 * Where the agent listens. `$STARBRIDGE_AGENT_SOCKET` wins. On Windows, the port file
 * `agent.port` in the config directory (`PortFile`). Elsewhere, for the default config directory,
 * `$XDG_RUNTIME_DIR/starbridge/agent.sock` when that is set (Linux), else `agent.sock` in the
 * config directory: macOS caps socket paths at 104 bytes, and its config path stays short. Any
 * other config directory (`$STARBRIDGE_CONFIG_DIR`, tests) keeps its socket inside it, so two
 * configurations never share an agent.
 */
export function socketPath(
  env: Record<string, string | undefined>,
  storeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.STARBRIDGE_AGENT_SOCKET) return env.STARBRIDGE_AGENT_SOCKET;
  if (platform === "win32") return join(storeDir, "agent.port");
  const standard = configDir({ ...env, STARBRIDGE_CONFIG_DIR: undefined });
  if (env.XDG_RUNTIME_DIR && storeDir === standard)
    return join(env.XDG_RUNTIME_DIR, "starbridge", "agent.sock");
  return join(storeDir, "agent.sock");
}

/**
 * Where an agent on loopback TCP listens, in the file its address names (#552). Node and Bun take
 * a socket path on Windows as a named pipe, which other local users can open, so there the agent
 * listens on 127.0.0.1 and writes this file into the config directory, which only its user can
 * read. `token`, new at each start, never crosses the wire: a call carries a fresh nonce and
 * `proof(token, "client", nonce)`, and the agent answers with `proof(token, "agent", nonce)`, so
 * a process that took the port after the agent stopped learns nothing it can use and cannot
 * answer. An address ending in `.port` names such a file on any platform.
 */
export interface PortFile {
  port: number;
  token: string;
  pid: number;
}

export const isPortFile = (address: string) => address.endsWith(".port");

export const NONCE_HEADER = "starbridge-nonce";
export const PROOF_HEADER = "starbridge-proof";

/**
 * That a side holds `token`: SHA-256 of `token:role:nonce` in hex. The mod's host offers SHA-256
 * but no HMAC; a role and a nonce in a fixed shape leave a length extension nothing to forge.
 */
export function proof(token: string, role: "client" | "agent", nonce: string): string {
  return createHash("sha256").update(`${token}:${role}:${nonce}`).digest("hex");
}

/** The port file at `path`, or undefined when it is missing or not one. */
export function readPortFile(path: string): PortFile | undefined {
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as Partial<PortFile>;
    if (
      Number.isInteger(f.port) &&
      typeof f.token === "string" &&
      f.token.length >= 32 &&
      Number.isInteger(f.pid)
    )
      return f as PortFile;
  } catch {}
  return undefined;
}

/**
 * Something the agent hands one session, oldest first, until the session confirms it with
 * `POST /v1/sessions/:id/ack` and the event's `ack`. Only answers today. A client skips types it
 * does not know and confirms nothing for them, so a new `type` breaks no client.
 */
export interface SessionEvent {
  type: string;
  /** Opaque; confirms this event. */
  ack: string;
  /** The prompt the mod submits into the session. */
  line: string;
  decisionId?: string;
}

/** `GET /v1/status`. */
export interface Status {
  version: string;
  api: { min: number; max: number };
  pid: number;
  startedAt: string;
  socket: string;
  /** Undefined until `starbridge pair` ran. */
  machine?: { id: string; name: string; server: string; account: string };
  server: { reachable: boolean; lastOkAt?: string; lastError?: string };
  quota: {
    providers: string[];
    intervalSeconds: number;
    lastPostAt?: string;
    lastError?: string;
  };
  sessions: SessionInfo[];
  /** Permission prompts (#57): whether they go to Starbridge, and how many wait now. */
  permissions?: { enabled: boolean; waiting: number };
}

/** A session the agent knows of, from `hello` or its event polls. */
export interface SessionInfo {
  id: string;
  /** The client and version, from the `user-agent` header, e.g. `starbridge-mod/0.1.0`. */
  client?: string;
  pid?: number;
  cwd?: string;
  title?: string;
  helloAt?: string;
  lastSeenAt: string;
}

/** An error body, as the server's: `{error, detail?}`. */
export interface ErrorBody {
  error: string;
  detail?: string;
  /** On 426: the agent's version and the API range it serves. */
  agent?: { version: string; api: { min: number; max: number } };
}
