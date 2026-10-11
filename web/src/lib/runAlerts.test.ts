import { expect, test } from "bun:test";
import { closeRun, notifyRuns } from "./runAlerts";
import type { RunItem } from "./types";

test("without a service worker, as in the desktop app, dismissing a run closes its notification (#1190)", async () => {
  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  const shown: { title: string; closed: boolean; close(): void }[] = [];
  g.Notification = class {
    static permission = "granted";
    closed = false;
    onclose?: () => void;
    constructor(readonly title: string) {
      shown.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  };
  const now = new Date().toISOString();
  const run: RunItem = {
    machine: "devbox",
    run: {
      v: 1,
      id: "r1",
      to: ["phone"],
      title: "Mac e2e",
      reason: "uses your screen",
      source: { machine: "devbox", project: "p", session: "s" },
      startedAt: now,
      at: now,
      exit: { code: 0, at: now },
    },
  };
  try {
    await notifyRuns([run], false);
    // Run again under its id: the second end notifies too, and the first's close untracks nothing.
    const later = new Date(Date.now() + 1000).toISOString();
    await notifyRuns(
      [{ ...run, run: { ...run.run, at: later, exit: { code: 1, at: later } } }],
      false,
    );
    shown[0]?.close();
    expect(shown.map((n) => n.closed)).toEqual([true, false]);
    await closeRun("r1");
    expect(shown.map((n) => n.closed)).toEqual([true, true]);
  } finally {
    delete g.localStorage;
    delete g.Notification;
  }
});
