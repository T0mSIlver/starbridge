import type { SealedItem } from "@starbridge/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
    message = `server: ${status} ${code}${detail ? ` (${detail})` : ""}`,
  ) {
    super(message);
  }
}

/** The server did not answer at all: down, or this machine is offline. */
export class Unreachable extends Error {}

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
    const headers: Record<string, string> = { ...opts.headers };
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
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status >= 400) {
      const e = (json ?? {}) as { error?: string; detail?: string };
      // The server drops a machine's token when the directory revokes the machine.
      if (res.status === 401 && this.token)
        throw new ApiError(
          401,
          e.error ?? res.statusText,
          e.detail,
          "this machine was removed from your Starbridge account: run `starbridge pair --force` to add it again",
        );
      throw new ApiError(res.status, e.error ?? res.statusText, e.detail);
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
    const q = new URLSearchParams({ wait: String(wait) });
    if (after !== undefined) q.set("after", after);
    if (known) q.set("directory", String(known.directory));
    if (known?.quotaAsked !== undefined) q.set("quotaAsked", known.quotaAsked);
    const r = await this.call("GET", `/answers?${q}`, { signal });
    // Each entry is `{item, cursor, receivedAt}` (PROTOCOL.md, Items); the CLI checks the item.
    const page = r.json as {
      items: { item?: unknown }[];
      cursor?: string;
      directory?: number;
      quotaAsked?: string;
    };
    return { ...page, items: page.items.map((e) => e.item) };
  }
}
