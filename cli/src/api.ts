import {
  CLIENT_HEADER,
  clientHeader,
  type MachineRelease,
  type SealedItem,
  visible,
} from "@starbridge/protocol";
import { VERSION } from "./version";

/** What every command and `status` say once the owner revoked this machine. */
export const REMOVED =
  "this machine was removed from your Starbridge account: run `starbridge pair --force` to add it again";

export class ApiError extends Error {
  /** With a 429, the seconds the server's Retry-After asks to wait. */
  retryAfter?: number;

  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
    message = `server: ${status} ${code}${detail ? ` (${detail})` : ""}`,
  ) {
    super(message);
  }
}

/** What a refused post says when the account or the server has no room left (#586). */
const FULL: Record<string, string> = {
  "account-full": "your Starbridge account is full; answer or settle open questions to free room",
  "storage-full": "the Starbridge server is out of storage; try again in an hour",
};

/** The server did not answer at all: down, or this machine is offline. */
export class Unreachable extends Error {}

/** The most a server's answer may be: a page of items, a directory. */
export const MAX_RESPONSE_BYTES = 32 << 20;
/** The most of an error's body that is read: only its three short fields matter. */
const MAX_ERROR_BYTES = 64 << 10;
/** The longest wait a Retry-After may ask for, in seconds. */
export const MAX_RETRY_AFTER = 300;
/** The most characters of a server's text that reach the terminal. */
const MAX_SERVER_TEXT = 200;
/** The most items one page of answers may hold, and the longest cursor. */
const MAX_PAGE_ITEMS = 1000;
const MAX_CURSOR = 256;
const MAX_ENTRY_CHARS = 4 << 20;
/** How long past its own `wait` an answers poll may take before the client gives up. */
const POLL_GRACE_MS = 30_000;

/**
 * A server's text, as the terminal may show it: control and bidi characters as escapes, cut to
 * MAX_SERVER_TEXT. Anything that is not a string is dropped.
 */
export function serverText(text: unknown): string | undefined {
  return typeof text === "string" ? visible(text).slice(0, MAX_SERVER_TEXT) : undefined;
}

/** The body of `res` as text, up to `max` bytes: the rest is cut off, or refused with `strict`. */
async function bodyText(res: Response, max: number, strict: boolean): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      if (strict) throw new Unreachable(`the server's answer is over ${max} bytes`);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Why a command Codex runs reaches no server, when that is the reason. */
export function sandboxHint(env: Record<string, string | undefined>): string | undefined {
  return env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? "Codex's sandbox has no network. `starbridge setup` adds the rule that lets starbridge ask, waiting, wait and settle out of it."
    : undefined;
}

/** The routes of PROTOCOL.md that a machine calls. */
export class Api {
  constructor(
    readonly server: string,
    private readonly token?: string,
  ) {}

  private async call(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      [CLIENT_HEADER]: clientHeader("cli", VERSION),
      ...opts.headers,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const base = this.server.replace(/\/+$/, "");
    let res: Response;
    try {
      res = await fetch(`${base}/v1${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      // Bun's messages guess at a typo; its code says what failed.
      const code = (e as { code?: unknown }).code;
      throw new Unreachable(
        `cannot reach ${base}${typeof code === "string" ? ` (${code})` : `: ${(e as Error).message}`}`,
      );
    }
    const text = await bodyText(
      res,
      res.status >= 400 ? MAX_ERROR_BYTES : MAX_RESPONSE_BYTES,
      res.status < 400,
    );
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status >= 400) {
      const raw = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
      const e = {
        error: serverText(raw.error),
        detail: serverText(raw.detail),
        minimum: serverText(raw.minimum),
      };
      if (res.status === 426)
        throw new ApiError(
          426,
          e.error ?? "client-too-old",
          e.detail,
          `this server needs starbridge ${e.minimum ?? "a newer release"} or later: run \`starbridge update\``,
        );
      // The server drops a machine's token when the directory revokes the machine.
      if (res.status === 401 && this.token)
        throw new ApiError(401, e.error ?? serverText(res.statusText) ?? "", e.detail, REMOVED);
      const err = new ApiError(
        res.status,
        e.error ?? serverText(res.statusText) ?? "",
        e.detail,
        ...(e.error && Object.hasOwn(FULL, e.error)
          ? [`${FULL[e.error]} (${e.detail ?? e.error})`]
          : []),
      );
      const wait = Number(res.headers.get("retry-after"));
      if (res.status === 429 && wait > 0) err.retryAfter = Math.min(wait, MAX_RETRY_AFTER);
      throw err;
    }
    return { status: res.status, json };
  }

  async postPairing(request: unknown, claimHash: string): Promise<void> {
    await this.call("POST", "/pairings", { body: { request, claimHash } });
  }

  /** Undefined when `wait` seconds pass without an approval. */
  async pairingResult(
    rendezvous: string,
    claim: string,
    wait: number,
    signal?: AbortSignal,
  ): Promise<{ approval: unknown; token?: string } | undefined> {
    const r = await this.call("GET", `/pairings/${rendezvous}/result?wait=${wait}`, {
      headers: { "x-claim": claim },
      ...(signal ? { signal } : {}),
    });
    if (r.status === 204) return undefined;
    return r.json as { approval: unknown; token?: string };
  }

  async directory(from: number, signal?: AbortSignal): Promise<unknown[]> {
    const r = await this.call("GET", `/directory?from=${from}`, signal ? { signal } : {});
    return (r.json as { entries: unknown[] }).entries;
  }

  /** The active machines that post quota snapshots, and when each posted its latest. */
  async quotaSenders(): Promise<{ id: string; receivedAt: string }[]> {
    const r = await this.call("GET", "/quota/senders", { signal: AbortSignal.timeout(15_000) });
    return (r.json as { senders: { id: string; receivedAt: string }[] }).senders;
  }

  /** Whether the owner sits at this machine's screen (#848): the one bit the server hears. */
  async presence(present: boolean, signal?: AbortSignal): Promise<void> {
    await this.call("PUT", "/presence", { body: { present }, ...(signal ? { signal } : {}) });
  }

  /** The CLI release this machine runs and the latest it knows, for the devices (#1050). */
  async release(body: MachineRelease, signal?: AbortSignal): Promise<void> {
    await this.call("PUT", "/release", { body, ...(signal ? { signal } : {}) });
  }

  async postItem(item: SealedItem, signal?: AbortSignal): Promise<void> {
    await this.call("POST", "/items", { body: item, ...(signal ? { signal } : {}) });
  }

  /**
   * The machine's inbox. With `known`, the server also replies at once when its directory is
   * longer or a device asked for quotas since `known.quotaAsked`.
   */
  async answers(
    after: string | undefined,
    wait: number,
    signal?: AbortSignal,
    known?: { directory: number; quotaAsked?: string },
  ): Promise<{ items: unknown[]; cursor?: string; directory?: number; quotaAsked?: string }> {
    const q = new URLSearchParams({ wait: String(wait), kinds: "answer,permission-answer,snooze" });
    if (after !== undefined) q.set("after", after);
    if (known) q.set("directory", String(known.directory));
    if (known?.quotaAsked !== undefined) q.set("quotaAsked", known.quotaAsked);
    // The server answers within `wait`; a connection that goes quiet must not hold the poll.
    const deadline = AbortSignal.timeout(wait * 1000 + POLL_GRACE_MS);
    const r = await this.call("GET", `/answers?${q}`, {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    }).catch((e) => {
      if (deadline.aborted && !signal?.aborted)
        throw new Unreachable(
          `the server did not answer the poll within ${wait + POLL_GRACE_MS / 1000} s`,
        );
      throw e;
    });
    // Each entry is `{item, cursor, receivedAt}` (PROTOCOL.md, Items); the CLI checks the item.
    const page = r.json as
      | {
          items?: unknown;
          cursor?: unknown;
          directory?: unknown;
          quotaAsked?: unknown;
        }
      | undefined;
    if (
      !page ||
      !Array.isArray(page.items) ||
      page.items.length > MAX_PAGE_ITEMS ||
      (page.cursor !== undefined &&
        (typeof page.cursor !== "string" || page.cursor.length > MAX_CURSOR)) ||
      (page.quotaAsked !== undefined &&
        (typeof page.quotaAsked !== "string" || page.quotaAsked.length > MAX_CURSOR)) ||
      (page.directory !== undefined && !Number.isSafeInteger(page.directory))
    )
      throw new Unreachable("the server sent a page of answers this client cannot read");
    return {
      // An entry over what the server accepts for an item cannot be genuine: it is skipped.
      items: (page.items as { item?: unknown }[])
        .filter((e) => JSON.stringify(e?.item ?? null).length <= MAX_ENTRY_CHARS)
        .map((e) => e?.item),
      ...(page.cursor !== undefined ? { cursor: page.cursor as string } : {}),
      ...(page.directory !== undefined ? { directory: page.directory as number } : {}),
      ...(page.quotaAsked !== undefined ? { quotaAsked: page.quotaAsked as string } : {}),
    };
  }
}
