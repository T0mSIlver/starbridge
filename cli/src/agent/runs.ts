/**
 * Runs in the agent: `starbridge run` hands it each update of a wrapped command, and the agent
 * seals it to every device and posts it with the machine's keys.
 */

import { RUN_LOST_MS } from "../autoupdate";
import { session } from "../context";
import { postRun, type RunInput } from "../run";
import { type Feature, HttpError, type Hub } from "./server";

/** How long a run's session keeps its id, from the run's last update, and how many ids are kept. */
const OWNER_MS = 24 * 60 * 60_000;
const MAX_OWNERS = 5_000;

export class Runs implements Feature {
  /** When each run not yet exited last updated through this agent. */
  private readonly last = new Map<string, number>();
  /** The session that started each run, so another cannot post updates under its id (#1763). */
  private readonly owners = new Map<string, { session: string; at: number }>();

  constructor(private readonly hub: Hub) {}

  /**
   * How many runs are in flight (#1266): not exited, and heard from in the last RUN_LOST_MS,
   * after which devices call a run lost.
   */
  inFlight(): number {
    const now = this.hub.ctx.now().getTime();
    for (const [id, at] of this.last) if (at < now - RUN_LOST_MS) this.last.delete(id);
    return this.last.size;
  }

  routes = [
    {
      method: "POST",
      path: "/v1/runs",
      handle: async (req: { body: unknown }) => {
        const run = (req.body as { run?: unknown } | undefined)?.run;
        if (typeof run !== "object" || run === null)
          throw new HttpError(400, "bad-request", "post {run: {id, title, reason, ...}}");
        const input = run as RunInput;
        if (typeof input.id === "string" && typeof input.session === "string") {
          const now = this.hub.ctx.now().getTime();
          for (const [id, o] of this.owners) if (!(now - o.at < OWNER_MS)) this.owners.delete(id);
          const owner = this.owners.get(input.id);
          if (owner && owner.session !== input.session)
            throw new HttpError(403, "run-owned", "that run belongs to another session");
          if (!owner && this.owners.size >= MAX_OWNERS)
            throw new HttpError(429, "too-many-runs", "too many runs are open");
          this.owners.set(input.id, { session: input.session, at: now });
        }
        // Counted before the post: a run whose updates the server refuses still runs here.
        // Pruned here too, so the map stays small whether or not anything asks.
        if (typeof input.id === "string") {
          if (input.exit) this.last.delete(input.id);
          else this.last.set(input.id, this.hub.ctx.now().getTime());
          this.inFlight();
        }
        const posted = await postRun(this.hub.ctx, session(this.hub.ctx), input);
        return { id: posted.id };
      },
    },
  ];
}
