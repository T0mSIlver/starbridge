/** Wakes long-polls in this process when something they wait for arrives. */
export class Waiters {
  private readonly waiting = new Map<string, Set<() => void>>();

  /**
   * Resolves true when `wake(key)` is called, false after `seconds` or when `signal` aborts.
   * Callers check their condition again after it resolves.
   */
  wait(key: string, seconds: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const set = this.waiting.get(key) ?? new Set();
      this.waiting.set(key, set);
      const done = (woken: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        set.delete(wake);
        if (set.size === 0 && this.waiting.get(key) === set) this.waiting.delete(key);
        resolve(woken);
      };
      const wake = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), seconds * 1000);
      set.add(wake);
      signal?.addEventListener("abort", onAbort);
    });
  }

  wake(key: string): void {
    for (const w of [...(this.waiting.get(key) ?? [])]) w();
  }

  /** Number of open waits, for tests. */
  count(key: string): number {
    return this.waiting.get(key)?.size ?? 0;
  }
}
