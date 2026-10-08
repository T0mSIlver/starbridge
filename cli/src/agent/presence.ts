/**
 * Presence in the agent (#848), once `starbridge config presence on`: every 10 s it reads this
 * machine's screen and tells the server whether the owner sits at it, again every 30 s while
 * they do, and once when they no longer do. Only that bit leaves the machine.
 */
import { isPresent, PRESENCE_BEAT_MS } from "@starbridge/protocol";
import { session } from "../context";
import { type Screen, screenReader } from "../screen";
import type { Status } from "./api";
import { type Feature, type Hub, pause } from "./server";

/** How often the screen is read: a lock reaches the server within this. */
export const READ_MS = 10_000;

export function presenceEnabled(hub: Hub): boolean {
  return hub.ctx.store.agentConfig().presence?.enabled === true;
}

export class Presence implements Feature {
  /** What the server last heard from this machine, and when. */
  private sent: { present: boolean; at: number } | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly hub: Hub,
    private readonly reader: { read: () => Promise<Screen | undefined>; stop: () => void } = screenReader(),
  ) {}

  status(into: Status) {
    into.presence = {
      enabled: presenceEnabled(this.hub),
      present: this.sent?.present === true,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private async send(present: boolean, signal?: AbortSignal): Promise<void> {
    const ctx = this.hub.ctx;
    if (!ctx.store.machine()) return;
    try {
      await session(ctx).api.presence(present, signal ?? AbortSignal.timeout(10_000));
      this.sent = { present, at: Date.now() };
      this.lastError = undefined;
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  /** One read: says present when it is, again once a beat passed, and absent once it is not. */
  async tick(now = Date.now()): Promise<void> {
    const screen = presenceEnabled(this.hub) ? await this.reader.read() : undefined;
    const present = screen !== undefined && isPresent(screen);
    if (present) {
      if (!this.sent?.present || now - this.sent.at >= PRESENCE_BEAT_MS) await this.send(true);
    } else if (this.sent?.present) await this.send(false);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await pause(READ_MS, signal);
    }
    // A stopping machine no longer vouches for the owner.
    if (this.sent?.present) await this.send(false, AbortSignal.timeout(3_000));
    this.reader.stop();
  }
}
