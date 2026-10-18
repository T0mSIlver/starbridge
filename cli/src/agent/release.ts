/**
 * The agent's update check (#1050): every hour it reads GitHub's latest release when the last
 * read is a day old, and tells the server which release this machine runs and the latest it
 * knows, whenever either changed since the server last took it, so devices show "Update
 * available". Every failure is silent and tried again an hour later.
 */
import type { MachineRelease } from "@starbridge/protocol";
import { session } from "../context";
import { checkLatest, updateCheckOn, within } from "../latest";
import { VERSION } from "../version";
import { type Feature, type Hub, pause } from "./server";

const TICK_MS = 3_600_000;

export class Release implements Feature {
  /** What the server last took from this machine. */
  private sent: string | undefined;

  constructor(private readonly hub: Hub) {}

  /**
   * Never throws: an unreadable config file or a failed call waits for the next tick. `signal`
   * ends both calls at once, so the agent's exit never waits on them.
   */
  async tick(signal?: AbortSignal): Promise<void> {
    const ctx = this.hub.ctx;
    try {
      const latest = updateCheckOn(ctx)
        ? ((await checkLatest(ctx, ctx.now(), signal))?.version ?? null)
        : null;
      if (signal?.aborted) return;
      if (!ctx.store.machine()) return;
      const body: MachineRelease = { version: VERSION, latest };
      const key = JSON.stringify(body);
      if (key === this.sent) return;
      await session(ctx).api.release(body, within(signal));
      this.sent = key;
    } catch {}
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick(signal);
      await pause(TICK_MS, signal);
    }
  }
}
