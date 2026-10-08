/**
 * Startup and open times, written to stdout as `timing {...}` lines when STARBRIDGE_TIMING is
 * set: what test/perf.ts reads, on any build, packaged ones included. Times are milliseconds
 * since the process started.
 */
const on = !!process.env.STARBRIDGE_TIMING;

export function mark(name: string, extra: Record<string, number> = {}): void {
  if (on)
    console.log(`timing ${JSON.stringify({ name, at: Math.round(performance.now()), ...extra })}`);
}

export const timing = on;
