/**
 * The local agent's API: HTTP with JSON bodies over a unix socket, or loopback TCP on Windows
 * (`PortFile`), for the CLI and the Claude Code mod on the same machine (PROTOCOL.md, "Local
 * agent API"). Both sides import this file.
 */
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  agentSocket,
  type PortFile,
  portTarget,
  configKey as sharedConfigKey,
} from "../../../mod/hooks/address";
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

export { CONFIG_HEADER, isPortFile, type PortFile } from "../../../mod/hooks/address";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The `configKey` of config folder `dir` (mod/hooks/address.ts). */
export function configKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  return sharedConfigKey(dir, platform === "win32", sha256);
}

/** Where the agent of config folder `storeDir` listens (`agentSocket` in mod/hooks/address.ts). */
export function socketPath(
  env: Record<string, string | undefined>,
  storeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const standard = configDir({ ...env, STARBRIDGE_CONFIG_DIR: undefined });
  const key = configKey(storeDir, platform);
  return agentSocket(env, { path: storeDir, standard, key }, platform === "win32", join);
}

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
    return portTarget(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Removes the port file at `path` while it still holds `token`, so the agent that wrote it, or
 * whatever stops that agent, never removes one a newer agent wrote since.
 */
export function dropPortFile(path: string, token: string): void {
  try {
    if (readPortFile(path)?.token === token) unlinkSync(path);
  } catch {}
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
  /** The decision's question, beside its id (#1697). */
  question?: string;
  /** An answer whose decision is marked waiting, which the mod hands over mid-turn (#1484). */
  waiting?: boolean;
  /** The Claude Code subagent that asked, which the mod sends the answer to (#1702). */
  subagent?: string;
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
  /** Presence (#848): whether it is on, and whether the server last heard the owner is here. */
  presence?: { enabled: boolean; present: boolean; lastError?: string };
  /** Automatic updates (#1266): what the last look found, while a newer release is out. */
  update?: string;
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
