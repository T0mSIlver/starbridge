/** A fixed-window counter per key, in memory. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True while `key` has made at most `limit` calls in the current `windowMs`. */
  allow(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      if (this.windows.size > 10_000) this.sweep(t, windowMs);
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  }

  private sweep(t: number, windowMs: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= windowMs) this.windows.delete(k);
  }
}
