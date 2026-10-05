/**
 * Quota uploads in the agent: runs CodexBar on a timer and posts a sealed snapshot, which
 * replaces `starbridge quota push` as the long-running uploader; `POST /v1/quota` posts one now.
 */
import type { QuotaSnapshot } from "@starbridge/protocol";
import { iso } from "../context";
import { pushOnce } from "../quota";
import type { Status } from "./api";
import { type Feature, HttpError, type Hub } from "./server";

export interface QuotaConfig {
  /** Empty: no timer; `POST /v1/quota` still works, for every provider CodexBar has on. */
  providers: string[];
  intervalMs: number;
  codexbar?: string;
}

export class Quota implements Feature {
  private lastPostAt: Date | undefined;
  private lastError: string | undefined;
  /** Set by `now`; the loop posts again instead of sleeping. */
  private wanted: string | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly hub: Hub,
    private readonly config: QuotaConfig,
  ) {}

  routes = [
    {
      method: "POST",
      path: "/v1/quota",
      handle: async (req: { body: unknown }) => {
        // No client-chosen CodexBar path: the agent runs only the binary its own config names.
        const providers = (req.body as { providers?: unknown } | undefined)?.providers;
        if (
          providers !== undefined &&
          !(Array.isArray(providers) && providers.every((p) => typeof p === "string"))
        )
          throw new HttpError(400, "bad-request", "providers is a list of names");
        return {
          snapshot: await this.push(providers ?? this.config.providers, this.config.codexbar),
        };
      },
    },
  ];

  private async push(providers: string[], codexbar: string | undefined): Promise<QuotaSnapshot> {
    try {
      const snap = await pushOnce(this.hub.ctx, {
        providers,
        ...(codexbar !== undefined ? { codexbar } : {}),
      });
      this.lastPostAt = this.hub.ctx.now();
      this.lastError = undefined;
      return snap;
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  /** Posts a snapshot now, or right after the one being taken, rather than at the next interval. */
  now(why: string) {
    if (this.config.providers.length === 0) return;
    this.wanted = why;
    this.wake?.();
  }

  /** Waits `ms`, or until `now` or `signal` ends the wait. */
  private nap(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        this.wake = undefined;
        resolve();
      };
      const t = setTimeout(done, ms);
      signal.addEventListener("abort", done);
      this.wake = done;
    });
  }

  status(into: Status) {
    into.quota = {
      providers: this.config.providers,
      intervalSeconds: this.config.providers.length > 0 ? this.config.intervalMs / 1000 : 0,
      ...(this.lastPostAt ? { lastPostAt: iso(this.lastPostAt) } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.config.providers.length === 0) {
      this.hub.log("quota uploads off: no providers configured");
      return;
    }
    while (!signal.aborted) {
      const started = Date.now();
      if (this.wanted) this.hub.log(`quota: ${this.wanted}`);
      this.wanted = undefined;
      if (this.hub.ctx.store.machine()) {
        try {
          const snap = await this.push(this.config.providers, this.config.codexbar);
          const windows = snap.providers.reduce((n, p) => n + p.windows.length, 0);
          this.hub.log(
            `posted ${snap.id}: ${snap.providers.length} providers, ${windows} windows, ${snap.alerts.length} alerts`,
          );
        } catch (e) {
          this.hub.log(`quota: ${(e as Error).message}`);
        }
      }
      if (!this.wanted)
        await this.nap(Math.max(0, started + this.config.intervalMs - Date.now()), signal);
    }
  }
}
