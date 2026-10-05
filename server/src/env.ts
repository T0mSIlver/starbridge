import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { Caller } from "./auth";
import type { Config } from "./config";
import type { Push } from "./push";
import type { RateLimiter } from "./ratelimit";
import type { Usage } from "./usage";
import type { Waiters } from "./waiters";

export interface Deps {
  config: Config;
  db: Database;
  push: Push;
  /** Wakes answer long-polls; keyed by "account/member". */
  answers: Waiters;
  /** Wakes pairing-result long-polls; keyed by rendezvous id. */
  pairings: Waiters;
  /** Wakes join long-polls; keyed by "join:<id>" and "account:<account>". */
  joins: Waiters;
  limiter: RateLimiter;
  usage: Usage;
}

export interface Env {
  Bindings: { server?: Server<undefined> };
  Variables: Deps & { caller: Caller };
}
