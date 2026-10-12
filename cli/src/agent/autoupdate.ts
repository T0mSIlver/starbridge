/**
 * Automatic updates (#1266): every 10 minutes the agent looks at the latest release its update
 * check read, and starts `starbridge update` once `decide` says so.
 */
import { autoOn, decide, inFlight, JITTER_MS, launchUpdate } from "../autoupdate";
import type { Ctx } from "../context";
import { installKind } from "../release";
import { VERSION } from "../version";
import type { Status } from "./api";
import { type Feature, type Hub, pause } from "./server";

export const LOOK_MS = 10 * 60_000;

export interface AutoUpdateDeps {
  install: typeof installKind;
  launch: (ctx: Ctx, binary: string) => Promise<string | undefined>;
  random: () => number;
}

export class AutoUpdate implements Feature {
  /** The release this agent first saw newer than itself, when, and its random delay. */
  private seen: { version: string; at: Date; jitterMs: number } | undefined;
  /** What the last look found, for `status`. */
  private state: string | undefined;

  /** `runs`: how many runs are in flight. */
  constructor(
    private readonly hub: Hub,
    private readonly runs: () => number,
    private readonly deps: AutoUpdateDeps = {
      install: installKind,
      launch: launchUpdate,
      random: Math.random,
    },
  ) {}

  /** Never throws: an unreadable file waits for the next look. */
  async tick(): Promise<void> {
    const ctx = this.hub.ctx;
    try {
      const install = this.deps.install();
      if (install.kind !== "binary" || !autoOn(ctx, install)) {
        this.state = undefined;
        return;
      }
      const latest = ctx.store.latest()?.version;
      const now = ctx.now();
      if (latest && this.seen?.version !== latest)
        this.seen = { version: latest, at: now, jitterMs: this.deps.random() * JITTER_MS };
      const d = decide({
        now,
        current: VERSION,
        latest,
        record: ctx.store.updates(),
        seenAt: this.seen?.at ?? now,
        jitterMs: this.seen?.jitterMs ?? 0,
        busy: inFlight(ctx.store.state(), now, this.runs()),
      });
      if ("none" in d) {
        this.state = undefined;
        return;
      }
      if ("wait" in d) {
        this.state = `${latest} ${d.wait}${d.until ? `, until ${d.until.toISOString()}` : ""}`;
        return;
      }
      ctx.store.recordUpdate((r) => {
        r.tried = { at: now.toISOString(), version: d.install };
      });
      this.hub.log(`update: starting \`starbridge update\` for ${d.install}`);
      this.state = `started the update to ${d.install}`;
      const why = await this.deps.launch(ctx, install.path);
      if (!why) return;
      this.hub.log(`update: could not start it: ${why}`);
      this.state = `could not start the update to ${d.install}: ${why}`;
      ctx.store.recordUpdate((r) => {
        r.failed = { at: now.toISOString(), version: d.install, why };
      });
    } catch (e) {
      this.hub.log(`update: ${(e as Error).message}`);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await pause(LOOK_MS, signal);
    }
  }

  status(into: Status): void {
    if (this.state) into.update = this.state;
  }
}
