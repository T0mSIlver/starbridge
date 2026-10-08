import type { Database } from "bun:sqlite";
import type { ClientVersion } from "@starbridge/protocol";
import type { Server } from "bun";
import type { Caller } from "./auth";
import type { Config } from "./config";
import type { Presence } from "./presence";
import type { Push } from "./push";
import type { RateLimiter } from "./ratelimit";
import type { PairingClients } from "./routes/pairings";
import type { Usage } from "./usage";
import type { Waiters } from "./waiters";
import type { Watch } from "./watch";

export interface Deps {
  config: Config;
  db: Database;
  push: Push;
  /** Wakes answer long-polls; keyed by "account/member". */
  answers: Waiters;
  /** Wakes `POST /quota/ask` waits when a machine posts a snapshot; keyed by account. */
  quotas: Waiters;
  /** When a device of each account last asked its machines for fresh quota snapshots. */
  quotaAsks: Map<string, string>;
  /** Wakes pairing-result long-polls; keyed by rendezvous id. */
  pairings: Waiters;
  pairingClients: PairingClients;
  /** Wakes join long-polls; keyed by "join:<id>" and "account:<account>". */
  joins: Waiters;
  limiter: RateLimiter;
  /** Who of each account sits at a screen (#848), in memory only. */
  presence: Presence;
  watch: Watch;
  usage: Usage;
}

export interface Env {
  Bindings: { server?: Server<undefined> };
  /** `client` is the `starbridge-client` header, read for every /v1 request. */
  Variables: Deps & { caller: Caller; client: ClientVersion | null };
}
