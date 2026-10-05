/** Wakes long-polls in this process when something they wait for arrives. */
export class Waiters {
  private readonly waiting = new Map<string, Set<(woken: boolean) => void>>();
  private closed = false;

  /**
   * Resolves true when `wake(key)` is called, false after `seconds` or when `signal` aborts.
   * Callers check their condition again after it resolves.
   */
  wait(key: string, seconds: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.closed) return resolve(false);
      const set = this.waiting.get(key) ?? new Set();
      this.waiting.set(key, set);
      const done = (woken: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        set.delete(done);
        if (set.size === 0 && this.waiting.get(key) === set) this.waiting.delete(key);
        resolve(woken);
      };
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), seconds * 1000);
      set.add(done);
      signal?.addEventListener("abort", onAbort);
    });
  }

  wake(key: string): void {
    for (const w of [...(this.waiting.get(key) ?? [])]) w(true);
  }

  /** Ends every wait as if its time passed, now and from now on: the server is shutting down. */
  close(): void {
    this.closed = true;
    for (const set of [...this.waiting.values()]) for (const w of [...set]) w(false);
  }

  /** Number of open waits, for tests. */
  count(key: string): number {
    return this.waiting.get(key)?.size ?? 0;
  }
}
