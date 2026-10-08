/** A fixed-window counter per key, in memory. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number; ms: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True while `key` has made at most `limit` calls in the current `windowMs`. */
  allow(key: string, limit: number, windowMs: number): boolean {
    return this.retryAfter(key, limit, windowMs) === 0;
  }

  /**
   * Counts a call, or `cost` units of a budget such as bytes; 0 when it is allowed, else the
   * seconds until `key`'s window ends.
   */
  retryAfter(key: string, limit: number, windowMs: number, cost = 1): number {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      if (this.windows.size > 10_000) this.sweep(t);
      this.windows.set(key, { start: t, count: cost, ms: windowMs });
      return cost <= limit ? 0 : Math.max(1, Math.ceil(windowMs / 1000));
    }
    // A window the owner lengthened at runtime (#786) lives as long as its new length.
    w.ms = windowMs;
    w.count += cost;
    return w.count <= limit ? 0 : Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
  }

  /** What `retryAfter` would answer for `cost`, without counting it. */
  peek(key: string, limit: number, windowMs: number, cost = 1): number {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowMs)
      return cost <= limit ? 0 : Math.max(1, Math.ceil(windowMs / 1000));
    return w.count + cost <= limit ? 0 : Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
  }

  /** Each window ends by its own length, so a short window's sweep never resets a long one. */
  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= w.ms) this.windows.delete(k);
  }
}
