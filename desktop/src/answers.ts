import type { Answered } from "./bridge";
import type { Shown } from "./notifier";

/**
 * Answers from notifications that the page is sending. One the page has not confirmed within
 * `ms` shows a failure notice but stays tracked, since the page may still send it (#1292): its
 * late word closes that notice on success, or replaces it with the page's error.
 */
export class Answers {
  private readonly pending = new Map<string, { timer?: NodeJS.Timeout; notice?: Shown }>();

  constructor(
    private readonly notSent: (id: string, why: string) => Shown,
    /** The answer went out: its question's notification closes. */
    private readonly sent: (id: string) => void,
    private readonly ms: number,
  ) {}

  start(id: string): void {
    this.drop(id);
    const p: { timer?: NodeJS.Timeout; notice?: Shown } = {};
    p.timer = setTimeout(() => {
      p.timer = undefined;
      p.notice = this.notSent(id, "Starbridge did not answer in time.");
    }, this.ms);
    this.pending.set(id, p);
  }

  /** The page's word on an answer; ignored for one it was not handed. */
  settle(a: Answered): void {
    if (!this.pending.has(a.id)) return;
    this.drop(a.id);
    if (a.error) this.notSent(a.id, a.error);
    else this.sent(a.id);
  }

  private drop(id: string): void {
    const p = this.pending.get(id);
    clearTimeout(p?.timer);
    p?.notice?.close();
    this.pending.delete(id);
  }
}
