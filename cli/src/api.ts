import type { SealedItem } from "@starbridge/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
  ) {
    super(`server: ${status} ${code}${detail ? ` (${detail})` : ""}`);
  }
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
    const res = await fetch(`${this.server.replace(/\/+$/, "")}/v1${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status >= 400) {
      const e = (json ?? {}) as { error?: string; detail?: string };
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
  ): Promise<{ approval: unknown; token?: string } | undefined> {
    const r = await this.call("GET", `/pairings/${rendezvous}/result?wait=${wait}`, {
      headers: { "x-claim": claim },
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
