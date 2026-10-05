/**
 * Runs in the agent: `starbridge run` hands it each update of a wrapped command, and the agent
 * seals it to every device and posts it with the machine's keys.
 */
import { session } from "../context";
import { postRun, type RunInput } from "../run";
import { type Feature, HttpError, type Hub } from "./server";

export class Runs implements Feature {
  constructor(private readonly hub: Hub) {}

  routes = [
    {
      method: "POST",
      path: "/v1/runs",
      handle: async (req: { body: unknown }) => {
        const run = (req.body as { run?: unknown } | undefined)?.run;
        if (typeof run !== "object" || run === null)
          throw new HttpError(400, "bad-request", "post {run: {id, title, reason, ...}}");
        const posted = await postRun(this.hub.ctx, session(this.hub.ctx), run as RunInput);
        return { id: posted.id };
      },
    },
  ];
}
