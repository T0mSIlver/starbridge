import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import type { Config } from "./config";
import type { Env } from "./env";

/**
 * The launch funnel (#559, #590): a new account's steps, which the server posts to Umami's
 * collect endpoint as they happen. The server sees each step whichever app took it, and no
 * blocker stands between it and Umami. Only accounts made in the last two days send anything.
 */
export type Step =
  | "first-sign-in"
  | "first-keys"
  | "first-machine"
  | "second-device"
  | "first-answer";

/** An account's steps after this are not sent: the launch funnel is about its first days. */
const NEW_FOR_MS = 2 * 24 * 3600 * 1000;

/**
 * Umami counts a user agent without one of a browser's markers as a bot and drops its events.
 * This one passes, and names who sent it.
 */
const USER_AGENT = "Mozilla/5.0 (compatible; Starbridge)";

export class Funnel {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Posts `step` for `account` if the account is new, unless the request that took it sends Do
   * Not Track, as Umami's tracker would. Umami makes one visit of each account's steps in a day
   * from `id`, the account's random `funnel_id` (#1745); it gets nothing else about the account.
   */
  reached(c: Context<Env>, account: string, step: Step, data?: Record<string, string>): void {
    const umami = this.config.umami;
    if (!umami || c.req.header("dnt") === "1") return;
    const row = this.db
      .query("SELECT created_at, funnel_id FROM accounts WHERE id = ?")
      .get(account) as { created_at: string; funnel_id: string | null } | null;
    if (!row || this.now() - Date.parse(row.created_at) >= NEW_FOR_MS) return;
    let id = row.funnel_id;
    if (!id) {
      id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
      this.db.query("UPDATE accounts SET funnel_id = ? WHERE id = ?").run(id, account);
    }
    const payload = {
      website: umami.websiteId,
      hostname: new URL(this.config.publicUrl).hostname,
      url: "/",
      title: "Starbridge",
      name: step,
      ...(data && { data }),
      id,
      // A loopback address: Umami looks up no place for it, and reads no client's address.
      ip: "127.0.0.1",
      userAgent: USER_AGENT,
    };
    // Counting is never worth failing or slowing a request.
    this.fetchFn(`${umami.url}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ type: "event", payload }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        if (!res.ok) console.error(`Umami refused ${step}: ${res.status}`);
      })
      .catch((e) => console.error(`Umami unreachable for ${step}: ${e}`));
  }
}
