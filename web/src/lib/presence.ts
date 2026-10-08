// Presence (#848): while this page is visible and had input in the last minute, the owner sits
// at it, so the server holds the other devices' pushes. Only that bit reaches the server, and no
// more than an input happened: never which key or where.
import { PRESENCE_BEAT_MS, PRESENCE_INPUT_MS } from "@starbridge/protocol";

/** How often the page checks whether it still counts: a minute without input ends it. */
export const PRESENCE_CHECK_MS = 10_000;

/** The BroadcastChannel a tab tells its siblings on that it is in use. */
export const PRESENCE_CHANNEL = "starbridge-presence";

/** The input events that count: a pointer, a key, a wheel, a touch. */
export const PRESENCE_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];

export class Beacon {
  private lastInput = Number.NEGATIVE_INFINITY;
  private sent: { present: boolean; at: number } | undefined;

  constructor(
    private readonly send: (present: boolean) => Promise<unknown>,
    private readonly visible: () => boolean,
    private readonly now: () => number = Date.now,
    /**
     * Whether another tab of this browser is in use: tabs share one device, so a tab going idle
     * says nothing while its sibling is in use.
     */
    private readonly sibling: () => boolean = () => false,
  ) {}

  present(): boolean {
    return this.visible() && this.now() - this.lastInput < PRESENCE_INPUT_MS;
  }

  /** An input on the page; the first after an absence says present at once. */
  input(): void {
    const was = this.present();
    this.lastInput = this.now();
    if (!was) void this.tick();
  }

  /** Says present when it is, again once a beat passed, and absent once it is not. */
  async tick(): Promise<void> {
    const present = this.present();
    const at = this.now();
    if (present && (!this.sent?.present || at - this.sent.at >= PRESENCE_BEAT_MS)) {
      // A failed beat is tried again a beat later, not at every check: a server without the
      // route refuses it every time.
      this.sent = { present, at };
      await this.send(true).catch(() => {});
    } else if (!present && this.sent?.present) {
      this.sent = { present, at };
      if (!this.sibling()) await this.send(false).catch(() => {});
    }
  }
}
