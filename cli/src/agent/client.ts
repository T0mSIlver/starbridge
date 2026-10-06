import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Ctx } from "../context";
import { processAlive } from "../platform";
import { VERSION } from "../version";
import {
  API,
  API_HEADER,
  type ErrorBody,
  isPortFile,
  NONCE_HEADER,
  PROOF_HEADER,
  proof,
  readPortFile,
  socketPath,
} from "./api";

/** No agent listens: the CLI talks to the server itself. */
export class NoAgent extends Error {}

/** The agent refused the call; `status` 426 means the two cannot work together. */
export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
  ) {
    super(body.detail ?? `agent: ${status} ${body.error}`);
  }
}

/**
 * The agent dropped the connection mid-call, as a restart does (#548): it may or may not have
 * carried the call out.
 */
export class AgentLost extends Error {}

/** Ctrl-C or SIGTERM cut a call short. */
export class Interrupted extends Error {}

/**
 * A connection error that proves the agent never saw the request, so falling back cannot do
 * anything twice: no socket file, nobody listening on it, not a socket, or a path too long for a
 * socket, which no agent can listen on either (#622).
 */
const NOT_LISTENING = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EINVAL"]);
/** A connection the agent closed under the call: it stopped or restarted. */
const DROPPED = new Set(["ECONNRESET", "EPIPE"]);

export class AgentClient {
  /** Set once the agent carried out a call: from then on, falling back could act twice. */
  answered = false;

  constructor(
    readonly socket: string,
    private readonly client = `starbridge-cli/${VERSION}`,
  ) {}

  /** The agent for this configuration, unless `STARBRIDGE_NO_AGENT` is set. */
  static for(ctx: Ctx): AgentClient | undefined {
    if (ctx.env.STARBRIDGE_NO_AGENT) return undefined;
    return new AgentClient(socketPath(ctx.env, ctx.store.dir));
  }

  /**
   * One call. Throws NoAgent when nothing listens, AgentError on a 4xx or 5xx. `timeoutMs`
   * covers the whole call, so it must exceed any `wait` the request asks the agent for.
   */
  call<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<T> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      // Before any request exists: one destroyed before its error listener is attached emits
      // "socket hang up" with nobody listening, which crashes the process (#98).
      if (signal?.aborted) return reject(new Interrupted("interrupted"));
      let target: { socketPath: string } | { host: string; port: number } = {
        socketPath: this.socket,
      };
      let auth: Record<string, string> = {};
      let expect: string | undefined;
      if (isPortFile(this.socket)) {
        const f = readPortFile(this.socket);
        if (!f || !processAlive(f.pid)) return reject(new NoAgent(`no agent on ${this.socket}`));
        target = { host: "127.0.0.1", port: f.port };
        const nonce = randomBytes(16).toString("hex");
        auth = {
          [NONCE_HEADER]: nonce,
          authorization: `Starbridge ${proof(f.token, "client", nonce)}`,
        };
        expect = proof(f.token, "agent", nonce);
      }
      const req = request(
        {
          ...target,
          // A fresh connection per call: a kept-alive one dies with an agent restart.
          agent: false,
          path,
          method,
          headers: {
            ...auth,
            [API_HEADER]: String(API),
            "user-agent": this.client,
            ...(text !== undefined
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(text) }
              : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          // Whatever took the port of an agent that stopped: nothing it says counts.
          if (expect !== undefined && res.headers[PROOF_HEADER] !== expect) {
            res.resume();
            return reject(
              new NoAgent(`no agent on ${this.socket}: the port answers without its proof`),
            );
          }
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (d) => {
            raw += d;
          });
          res.on("end", () => {
            let json: unknown;
            try {
              json = raw ? JSON.parse(raw) : undefined;
            } catch {
              json = undefined;
            }
            const status = res.statusCode ?? 0;
            // A refusal (4xx) did nothing, so a fallback after one cannot act twice.
            if (status < 400) this.answered = true;
            if (status >= 400) {
              const e = (json ?? {}) as ErrorBody;
              reject(new AgentError(status, { ...e, error: e.error ?? `status ${status}` }));
            } else resolve(json as T);
          });
          res.on("error", (e: NodeJS.ErrnoException) =>
            reject(e.code && DROPPED.has(e.code) ? new AgentLost(e.message) : e),
          );
        },
      );
      const onAbort = () => {
        req.destroy();
        reject(new Interrupted("interrupted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal?.removeEventListener("abort", onAbort));
      req.on("timeout", () => req.destroy(new Error(`agent: no answer within ${timeoutMs} ms`)));
      req.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code && NOT_LISTENING.has(e.code)) reject(new NoAgent(`no agent on ${this.socket}`));
        else if (e.code && DROPPED.has(e.code))
          reject(new AgentLost(`the agent dropped the call: ${e.message}`));
        else reject(e);
      });
      req.end(text);
    });
  }
}

/**
 * Runs `viaAgent` when an agent runs, else `direct`, the CLI's own path to the server. An agent
 * too old or too new for this CLI (426) also falls back, after a warning that says which to
 * update, so a fresh binary works before the service restarts.
 */
export async function withAgent<T>(
  ctx: Ctx,
  viaAgent: (agent: AgentClient) => Promise<T>,
  direct: () => Promise<T>,
): Promise<T> {
  const agent = AgentClient.for(ctx);
  if (!agent) return direct();
  try {
    return await viaAgent(agent);
  } catch (e) {
    if (e instanceof NoAgent && !agent.answered) return direct();
    if (e instanceof NoAgent) throw new Error("the agent stopped in the middle of the command");
    if (e instanceof AgentError && e.status === 426 && !agent.answered) {
      ctx.err(`starbridge: ${e.body.detail ?? e.message}; going to the server directly`);
      return direct();
    }
    throw e;
  }
}
