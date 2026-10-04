/**
 * `starbridge agent`: one per machine, as a user service. It holds the machine keys and the one
 * connection to the server, and serves the CLI and the Claude Code sessions on this machine over
 * a unix socket (PROTOCOL.md, "Local agent API"). Each feature (decisions, quota uploads, runs;
 * later permission prompts #57) plugs in as a `Feature`: its routes, the
 * events it hands sessions, the acks it takes and its background loop.
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { ProtocolError } from "@starbridge/protocol";
import { ApiError } from "../api";
import { type Ctx, iso, UsageError } from "../context";
import { VERSION } from "../version";
import {
  API,
  API_HEADER,
  type ErrorBody,
  MAX_HOLD_SECONDS,
  MIN_API,
  type SessionEvent,
  type SessionInfo,
  type Status,
} from "./api";
import { AgentClient, AgentError, NoAgent } from "./client";

export interface Request {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Aborts when the client hangs up or the agent stops. */
  signal: AbortSignal;
  /** The `user-agent` header, e.g. `starbridge-cli/0.1.0`. */
  client?: string;
}

export interface Route {
  method: string;
  /** `/v1/sessions/:id/events`: `:name` matches one path segment. */
  path: string;
  handle(req: Request): Promise<unknown>;
}

/** A 4xx the handler chose; anything else thrown becomes a 400, 502 or 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export interface Feature {
  routes?: Route[];
  /** What session `id` has not confirmed yet, oldest first. */
  events?(session: string): SessionEvent[];
  /** Confirms events; tokens this feature did not hand out must be ignored. */
  ack?(session: string, tokens: string[]): void;
  /** The session said `bye`: drop what belongs to that session. */
  bye?(session: string): void;
  /** A background loop; resolves once `signal` aborts. */
  run?(signal: AbortSignal): Promise<void>;
  status?(into: Status): void;
}

/** What features get from the agent. */
export interface Hub {
  ctx: Ctx;
  /** Wakes every request waiting for events or answers: something may be ready now. */
  notify(): void;
  /** Resolves on the next `notify`, after `ms`, or when `signal` aborts. */
  changed(ms: number, signal: AbortSignal): Promise<void>;
  log(line: string): void;
}

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_BODY = 1 << 20;

/** Waits `ms`, or less when `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

export class Agent implements Hub {
  private server: Server | undefined;
  private readonly stopping = new AbortController();
  private readonly waiters = new Set<() => void>();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly routes: (Route & { pattern: RegExp; names: string[] })[] = [];
  private loops: Promise<void>[] = [];
  private readonly startedAt: Date;
  private readonly features: Feature[];

  constructor(
    readonly ctx: Ctx,
    readonly socket: string,
    features: (hub: Hub) => Feature[],
  ) {
    this.startedAt = ctx.now();
    this.features = features(this);
    const core: Route[] = [
      { method: "GET", path: "/v1/status", handle: async () => this.status() },
      { method: "POST", path: "/v1/sessions/:id/hello", handle: (r) => this.hello(r) },
      { method: "POST", path: "/v1/sessions/:id/bye", handle: (r) => this.bye(r) },
      { method: "GET", path: "/v1/sessions/:id/events", handle: (r) => this.events(r) },
      { method: "POST", path: "/v1/sessions/:id/ack", handle: (r) => this.ack(r) },
    ];
    for (const route of [...core, ...this.features.flatMap((f) => f.routes ?? [])]) {
      const names: string[] = [];
      const source = route.path.replace(/:(\w+)/g, (_, name: string) => {
        names.push(name);
        return "([^/]+)";
      });
      this.routes.push({ ...route, pattern: new RegExp(`^${source}$`), names });
    }
  }

  log(line: string) {
    this.ctx.err(`${iso(this.ctx.now())} ${line}`);
  }

  notify() {
    for (const wake of [...this.waiters]) wake();
  }

  changed(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
      if (signal.aborted) done();
      else signal.addEventListener("abort", done);
    });
  }

  /**
   * Listens on the socket and starts the features' loops. Refuses when another agent answers
   * on it; a socket file nobody listens on is left from a crash and goes.
   */
  async start(): Promise<void> {
    try {
      await new AgentClient(this.socket).call("GET", "/v1/status", undefined, 2_000);
      throw new UsageError(`an agent already runs on ${this.socket}`);
    } catch (e) {
      if (!(e instanceof NoAgent || e instanceof AgentError)) throw e;
      if (e instanceof AgentError) throw new UsageError(`an agent already runs on ${this.socket}`);
    }
    const dir = dirname(this.socket);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (dir === this.ctx.store.dir || dir.endsWith("/starbridge")) chmodSync(dir, 0o700);
    try {
      if (lstatSync(this.socket).isSocket()) unlinkSync(this.socket);
    } catch {}
    const server = createServer((req, res) =>
      this.serve(req, res).catch((e) => {
        // A request must never take the agent down with it.
        this.log(`${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }),
    );
    // Held requests last up to MAX_HOLD_SECONDS; Node's default timeouts would cut them.
    server.requestTimeout = 0;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socket, () => resolve());
    });
    chmodSync(this.socket, 0o600);
    this.server = server;
    this.loops = this.features.flatMap((f) => (f.run ? [f.run(this.stopping.signal)] : []));
    this.log(`starbridge agent ${VERSION} listening on ${this.socket}`);
  }

  /** Stops the loops, ends held requests and removes the socket. */
  async stop(): Promise<void> {
    this.stopping.abort();
    this.notify();
    const server = this.server;
    this.server = undefined;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      try {
        unlinkSync(this.socket);
      } catch {}
    }
    await Promise.allSettled(this.loops);
  }

  private async serve(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, json: unknown) => {
      const text = JSON.stringify(json ?? {});
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
    };
    const fail = (status: number, body: ErrorBody) => send(status, body);
    const api = Number(req.headers[API_HEADER]);
    if (!Number.isInteger(api) || api < MIN_API || api > API) {
      const tooOld = Number.isInteger(api) && api > API;
      return fail(426, {
        error: tooOld ? "agent-too-old" : "client-too-old",
        detail: tooOld
          ? `the agent (starbridge ${VERSION}) is older than this client: update starbridge and restart the agent`
          : `this client is older than the agent (starbridge ${VERSION}): update it`,
        agent: { version: VERSION, api: { min: MIN_API, max: API } },
      });
    }
    const url = new URL(req.url ?? "/", "http://agent");
    let params: Record<string, string> | undefined;
    const route = this.routes.find((r) => {
      if (r.method !== req.method) return false;
      const m = r.pattern.exec(url.pathname);
      if (!m) return false;
      params = Object.fromEntries(r.names.map((n, i) => [n, decode(m[i + 1] ?? "")]));
      return true;
    });
    if (!route || !params) return fail(404, { error: "not-found", detail: url.pathname });
    if (Object.values(params).includes(BAD_ESCAPE))
      return fail(400, { error: "bad-path", detail: "a malformed escape in the path" });
    const gone = new AbortController();
    const onStop = () => gone.abort();
    this.stopping.signal.addEventListener("abort", onStop);
    res.on("close", () => {
      gone.abort();
      this.stopping.signal.removeEventListener("abort", onStop);
    });
    try {
      const body = await readBody(req);
      const ua = req.headers["user-agent"];
      const out = await route.handle({
        params,
        query: url.searchParams,
        body,
        signal: gone.signal,
        ...(ua ? { client: ua } : {}),
      });
      if (!res.writableEnded) send(200, out);
    } catch (e) {
      if (res.writableEnded) return;
      if (e instanceof HttpError) return fail(e.status, { error: e.code, detail: e.message });
      if (e instanceof UsageError) return fail(400, { error: "bad-request", detail: e.message });
      if (e instanceof ApiError || e instanceof ProtocolError)
        return fail(502, { error: "server", detail: e.message });
      this.log(`${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      fail(500, { error: "internal", detail: (e as Error).message });
    }
  }

  private status(): Status {
    const m = this.ctx.store.machine();
    const out: Status = {
      version: VERSION,
      api: { min: MIN_API, max: API },
      pid: process.pid,
      startedAt: iso(this.startedAt),
      socket: this.socket,
      ...(m ? { machine: { id: m.id, name: m.name, server: m.server, account: m.account } } : {}),
      server: { reachable: false },
      quota: { providers: [], intervalSeconds: 0 },
      sessions: [...this.sessions.values()],
    };
    for (const f of this.features) f.status?.(out);
    return out;
  }

  private sessionId(req: Request): string {
    const id = req.params.id ?? "";
    if (!SESSION_ID.test(id)) throw new HttpError(400, "bad-session", "not a session id");
    return id;
  }

  /** Records that session `id` is alive, with what its client said about it. */
  private touch(id: string, req: Request, hello?: Partial<SessionInfo>): SessionInfo {
    const now = iso(this.ctx.now());
    const info: SessionInfo = {
      ...(this.sessions.get(id) ?? { id }),
      ...hello,
      id,
      ...(req.client ? { client: req.client } : {}),
      lastSeenAt: now,
    };
    this.sessions.set(id, info);
    return info;
  }

  private async hello(req: Request) {
    const id = this.sessionId(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pick = <T>(v: unknown, type: string) => (typeof v === type ? (v as T) : undefined);
    const pid = pick<number>(b.pid, "number");
    const cwd = pick<string>(b.cwd, "string");
    const title = pick<string>(b.title, "string");
    this.touch(id, req, {
      helloAt: iso(this.ctx.now()),
      ...(pid !== undefined ? { pid } : {}),
      ...(cwd !== undefined ? { cwd: cwd.slice(0, 1000) } : {}),
      ...(title !== undefined ? { title: title.slice(0, 200) } : {}),
    });
    return { version: VERSION };
  }

  private async bye(req: Request) {
    const id = this.sessionId(req);
    this.sessions.delete(id);
    for (const f of this.features) f.bye?.(id);
    return {};
  }

  private collect(id: string): SessionEvent[] {
    return this.features.flatMap((f) => f.events?.(id) ?? []);
  }

  /**
   * `GET /v1/sessions/:id/events?wait=<s>`: the session's unconfirmed events, held up to `wait`
   * seconds (at most MAX_HOLD_SECONDS) while there are none.
   */
  private async events(req: Request) {
    const id = this.sessionId(req);
    const wait = holdSeconds(req.query.get("wait"));
    this.touch(id, req);
    const end = Date.now() + wait * 1000;
    let events = this.collect(id);
    while (events.length === 0 && !req.signal.aborted && Date.now() < end) {
      await this.changed(end - Date.now(), req.signal);
      events = this.collect(id);
    }
    return { events };
  }

  private async ack(req: Request) {
    const id = this.sessionId(req);
    const acks = (req.body as { acks?: unknown } | undefined)?.acks;
    if (!Array.isArray(acks) || !acks.every((a) => typeof a === "string"))
      throw new HttpError(400, "bad-request", "ack takes {acks: [string]}");
    this.touch(id, req);
    for (const f of this.features) f.ack?.(id, acks);
    return {};
  }
}

const BAD_ESCAPE = "\u0000bad-escape";

/** A path segment decoded, or BAD_ESCAPE when its percent escapes are malformed. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return BAD_ESCAPE;
  }
}

/** `?wait=` as whole seconds from 0 to MAX_HOLD_SECONDS; none means 0. */
export function holdSeconds(text: string | null | undefined): number {
  if (text === null || text === undefined || text === "") return 0;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > MAX_HOLD_SECONDS)
    throw new HttpError(400, "bad-wait", `wait takes whole seconds from 0 to ${MAX_HOLD_SECONDS}`);
  return n;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "too-large", `bodies stop at ${MAX_BODY} bytes`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "bad-json", "the body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}
