import type { Entry } from "./bridge";

/** A shown notification, as the notifier needs it. */
export interface Shown {
  close(): void;
}

/**
 * Keeps one notification per entry the page sends: a new entry shows one, an entry whose agent
 * starts waiting shows it again, and an entry that left (answered anywhere, snoozed, settled)
 * closes it. Entries already notified before a restart, `known`, are not shown again.
 */
export class Notifier {
  private readonly shown = new Map<string, { waiting: boolean; note?: Shown }>();

  constructor(
    private readonly show: (entry: Entry) => Shown,
    known: Iterable<string> = [],
    private readonly remember: (ids: string[]) => void = () => {},
  ) {
    for (const id of known) this.shown.set(id, { waiting: true });
  }

  update(entries: Entry[]): void {
    const now = new Set(entries.map((e) => e.id));
    for (const [id, s] of this.shown)
      if (!now.has(id)) {
        s.note?.close();
        this.shown.delete(id);
      }
    for (const e of entries) {
      const s = this.shown.get(e.id);
      if (s && (s.waiting || !e.waiting)) {
        s.waiting = e.waiting;
        continue;
      }
      s?.note?.close();
      this.shown.set(e.id, { waiting: e.waiting, note: this.show(e) });
    }
    this.remember([...this.shown.keys()]);
  }

  /**
   * Forgets an entry whose notification macOS refused, as while its question to allow
   * notifications is still open: the page's next update shows it again.
   */
  forget(id: string): void {
    if (!this.shown.delete(id)) return;
    this.remember([...this.shown.keys()]);
  }

  /** Closes an entry's notification, as after its answer from that notification was sent. */
  close(id: string): void {
    const s = this.shown.get(id);
    s?.note?.close();
    if (s) s.note = undefined;
  }
}
