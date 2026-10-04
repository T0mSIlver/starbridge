import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { Caller } from "./auth";
import type { Config } from "./config";
import type { Push } from "./push";
import type { RateLimiter } from "./ratelimit";
import type { Waiters } from "./waiters";

export interface Deps {
  config: Config;
  db: Database;
  push: Push;
  /** Wakes answer long-polls; keyed by "account/member". */
  answers: Waiters;
  /** Wakes pairing-result long-polls; keyed by rendezvous id. */
  pairings: Waiters;
  limiter: RateLimiter;
}

export interface Env {
  Bindings: { server?: Server<undefined> };
  Variables: Deps & { caller: Caller };
}
