import {
  CLIENT_HEADER,
  type ClientName,
  type ClientTooOld,
  parseClientHeader,
  versionBelow,
} from "@starbridge/protocol";
import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

/**
 * The oldest release of each client the server serves; an older one gets 426 `client-too-old`.
 * Empty at launch. Raising one is how a compatibility branch marked `// until min cli >= 1.2`
 * gets deleted.
 */
export const MINIMUM_RELEASES: Partial<Record<ClientName, string>> = {};

/** Reads `starbridge-client` into `c.var.client`, and refuses a release below its minimum. */
export const clientVersion: MiddlewareHandler<Env> = async (c, next) => {
  const client = parseClientHeader(c.req.header(CLIENT_HEADER));
  const minimum = client && c.var.config.minimumReleases[client.name];
  if (client && minimum && versionBelow(client, minimum)) {
    const body: ClientTooOld = {
      error: "client-too-old",
      detail: `update Starbridge: this server needs ${client.name} ${minimum} or later`,
      client: client.name,
      minimum,
    };
    return c.json(body, 426);
  }
  c.set("client", client);
  await next();
};
