import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { Env } from "./env";
import { ipKey } from "./limits";

const top = (m: Map<string, number>, n: number, over = 0) =>
  Object.fromEntries(
    [...m]
      .filter(([, v]) => v >= over)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n),
  );

/**
 * What the launch watcher reads from the running server (#782); Caddy keeps no access log.
 *
 * Refusals are counted by status, error code, method and route pattern, never the path's ids,
 * with the accounts refused most, and logged as one line a minute: account ids may be in logs
 * (privacy page), addresses never.
 *
 * Addresses are counted in memory only, like the rate limits: requests per address this minute
 * and the last, and the addresses refused with 429. The watcher reads them through the box-only
 * port (`WATCH_PORT`) and names only an address over its threshold or refused right now, so a
 * flood over a few HTTP/2 connections is still seen. A restart clears them.
 */
export class Watch {
  private refusals = new Map<string, number>();
  private refusedAccounts = new Map<string, number>();
  private requests = new Map<string, number>();
  private lastRequests = new Map<string, number>();
  private limited = new Map<string, number>();
  private lastLimited = new Map<string, number>();

  request(address: string): void {
    this.requests.set(address, (this.requests.get(address) ?? 0) + 1);
  }

  refused(key: string, account: string | undefined, address: string, status: number): void {
    this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
    if (account) this.refusedAccounts.set(account, (this.refusedAccounts.get(account) ?? 0) + 1);
    if (status === 429) this.limited.set(address, (this.limited.get(address) ?? 0) + 1);
  }

  /** The refusals since the last call, as one log line, or null when nothing was refused. */
  flush(): string | null {
    if (this.refusals.size === 0) return null;
    const line = `refusals ${JSON.stringify({ counts: top(this.refusals, 50), accounts: top(this.refusedAccounts, 5) })}`;
    this.refusals.clear();
    this.refusedAccounts.clear();
    return line;
  }

  /** Starts a new minute for the address counts; the one before is kept for `addresses`. */
  rotate(): void {
    this.lastRequests = this.requests;
    this.requests = new Map();
    this.lastLimited = this.limited;
    this.limited = new Map();
  }

  /**
   * Addresses that made at least `over` requests in the last full minute or this one, and those
   * answered 429 in either, with their counts. Everyone else is a count.
   */
  addresses(over: number) {
    const merge = (
      a: Map<string, number>,
      b: Map<string, number>,
      f: (x: number, y: number) => number,
    ) => {
      const out = new Map(a);
      for (const [k, v] of b) out.set(k, f(out.get(k) ?? 0, v));
      return out;
    };
    return {
      addressesLastMinute: this.lastRequests.size,
      busiestLastMinute: [...this.lastRequests.values()].reduce((a, b) => Math.max(a, b), 0),
      busy: top(merge(this.lastRequests, this.requests, Math.max), 20, over),
      limited: top(
        merge(this.lastLimited, this.limited, (x, y) => x + y),
        20,
      ),
    };
  }
}

/** 401 and 404 are clients signed out or probing, not limits. */
const COUNTED = new Set([400, 403, 409, 413, 426, 429, 500, 502, 503]);

export function watchRequests(watch: Watch): MiddlewareHandler<Env> {
  return async (c, next) => {
    const address = ipKey(c);
    watch.request(address);
    await next();
    const status = c.res.status;
    if (!COUNTED.has(status)) return;
    const body = (await c.res
      .clone()
      .json()
      .catch(() => ({}))) as { error?: unknown };
    const error = typeof body.error === "string" ? body.error : "-";
    watch.refused(
      `${status} ${error} ${c.req.method} ${routePath(c, -1)}`,
      c.var.caller?.account,
      address,
      status,
    );
  };
}
