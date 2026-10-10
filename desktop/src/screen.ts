/**
 * Presence from the Mac itself (#945): the page counts the owner present while they use its
 * window, and this tells it about the rest of the Mac. Lock, sleep and quitting make the owner
 * away at once, and the seconds since the Mac's last input, the number macOS keeps for its
 * screensaver, say whether they work in another app (#1003: always, since the hold is the opt-in). The
 * page reduces the reading to the one bit it sends (`isPresent`), so nothing else leaves the Mac,
 * and nothing here learns what is on screen or typed.
 */

/** What the page gets: away (locked, asleep or quitting), and the idle time. */
export interface Reading {
  away: boolean;
  /** Milliseconds since the Mac's last input; null while asleep or quitting. */
  idleMs: number | null;
}

/** The part of Electron's `powerMonitor` this reads. */
export interface Monitor {
  getSystemIdleTime(): number;
  getSystemIdleState(idleThreshold: number): string;
  on(event: "lock-screen" | "unlock-screen" | "suspend" | "resume", listener: () => void): unknown;
}

/** How often the idle time is read, as the page checks its own input. */
export const SCREEN_CHECK_MS = 10_000;

export class Screen {
  private locked = false;
  private asleep = false;
  private quitting = false;
  private last: string | undefined;

  constructor(
    private readonly monitor: Monitor,
    private readonly tell: (r: Reading) => void,
  ) {
    monitor.on("lock-screen", () => this.set(() => (this.locked = true)));
    monitor.on("unlock-screen", () => this.set(() => (this.locked = false)));
    monitor.on("suspend", () => this.set(() => (this.asleep = true)));
    monitor.on("resume", () => this.set(() => (this.asleep = false)));
    this.lockedBefore();
  }

  /**
   * Catches a lock that came before the app, which sent no event, from the lock state macOS
   * reports with the idle time. Read once, not at each check: at an unlock it can still say
   * locked, which kept the owner away until the next check.
   */
  private lockedBefore(): void {
    if (this.monitor.getSystemIdleState(1) === "locked") this.locked = true;
  }

  read(): Reading {
    return {
      away: this.locked || this.asleep || this.quitting,
      idleMs: !this.asleep && !this.quitting ? this.monitor.getSystemIdleTime() * 1_000 : null,
    };
  }

  /** Tells the page the reading: at every check while awake, else when it changes. */
  check(always = false): void {
    const r = this.read();
    const key = JSON.stringify(r);
    if (!always && r.idleMs === null && key === this.last) return;
    this.last = key;
    this.tell(r);
  }

  /** Quitting: the owner is away from here from now on. Told even if already away, so the app hears back. */
  quit(): void {
    this.quitting = true;
    this.check(true);
  }

  private set(change: () => void): void {
    change();
    this.check();
  }
}
