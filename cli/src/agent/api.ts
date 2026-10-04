/**
 * The local agent's API: HTTP with JSON bodies over a unix socket, for the CLI and the Claude
 * Code mod on the same machine (PROTOCOL.md, "Local agent API"). Both sides import this file.
 */
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
 * Where the agent listens. `$STARBRIDGE_AGENT_SOCKET` wins. For the default config directory,
 * `$XDG_RUNTIME_DIR/starbridge/agent.sock` when that is set (Linux), else `agent.sock` in the
 * config directory: macOS caps socket paths at 104 bytes, and its config path stays short. Any
 * other config directory (`$STARBRIDGE_CONFIG_DIR`, tests) keeps its socket inside it, so two
 * configurations never share an agent.
 */
export function socketPath(env: Record<string, string | undefined>, storeDir: string): string {
  if (env.STARBRIDGE_AGENT_SOCKET) return env.STARBRIDGE_AGENT_SOCKET;
  const standard = configDir({ ...env, STARBRIDGE_CONFIG_DIR: undefined });
  if (env.XDG_RUNTIME_DIR && storeDir === standard)
    return join(env.XDG_RUNTIME_DIR, "starbridge", "agent.sock");
  return join(storeDir, "agent.sock");
}

/**
 * Something the agent hands one session, oldest first, until the session confirms it with
 * `POST /v1/sessions/:id/ack` and the event's `ack`. Answers and default-time notices today;
 * #57 adds permission answers as a new `type`. A client skips types it does
 * not know and confirms nothing for them.
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
