import type { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import webpush from "web-push";
import { z } from "zod";
import type { Config } from "./config";

export const PushType = z.enum(["fcm", "webpush", "unifiedpush"]);
export type PushType = z.infer<typeof PushType>;

export const PushKeys = z.object({ p256dh: z.string().max(200), auth: z.string().max(100) });

export const PushTarget = z.object({
  type: PushType,
  /** An FCM registration token, or the push service URL. */
  endpoint: z.string().min(1).max(4096),
  keys: PushKeys.optional(),
});
export type PushTarget = z.infer<typeof PushTarget>;

/** "gone" means the target no longer exists and its subscription should be dropped. */
export type PushResult = "ok" | "gone" | "failed" | "no-route";

/** Returns why `target` cannot be accepted, or undefined. */
export function checkTarget(target: PushTarget, allowPrivate: boolean): string | undefined {
  if (target.type === "fcm") {
    return /^[A-Za-z0-9_:.-]+$/.test(target.endpoint) ? undefined : "not an FCM token";
  }
  if (target.type === "webpush" && !target.keys) return "webpush needs keys";
  let url: URL;
  try {
    url = new URL(target.endpoint);
  } catch {
    return "endpoint is not a URL";
  }
  if (allowPrivate)
    return url.protocol === "https:" || url.protocol === "http:" ? undefined : "bad scheme";
  if (url.protocol !== "https:") return "endpoint must be https";
  if (isPrivateHost(url.hostname)) return "endpoint is a private address";
  return undefined;
}

/**
 * Refuses hosts that name this machine or a private network, so a subscription cannot make the
 * server call into its own network. `Push` also checks the addresses a name resolves to.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  )
    return true;
  if (isIP(h) === 4) return privateV4(h);
  if (isIP(h) === 6) {
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return privateV4(mapped[1]);
    return (
      h === "::" ||
      h === "::1" ||
      /^f[cd]/.test(h) ||
      /^fe[89ab]/.test(h) ||
      h.startsWith("::ffff:")
    );
  }
  return false;
}

function privateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Most pushes one account has in flight at once; the rest wait their turn. */
const ACCOUNT_CONCURRENCY = 4;
/** Most pushes one account may have waiting; later ones are dropped. */
const ACCOUNT_QUEUE = 200;

/** A request to a push service, as `web-push` builds it. */
export interface PushRequest {
  method: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer> | null;
}

/**
 * Sends `req` to `url` over HTTPS, connecting to `address` while SNI and the certificate check
 * still use the URL's host. Returns the HTTP status.
 */
export type PinnedSend = (
  url: URL,
  address: string,
  req: PushRequest,
  timeoutMs: number,
) => Promise<number>;

export const pinnedHttps: PinnedSend = (url, address, req, timeoutMs) =>
  new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const r = request(
      {
        host,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
        servername: isIP(host) ? undefined : host,
        // No pooled connection may skip the lookup below.
        agent: false,
        lookup: (_host, opts, cb) => {
          const family = isIP(address);
          if ((opts as { all?: boolean }).all) cb(null, [{ address, family }]);
          else (cb as (e: null, a: string, f: number) => void)(null, address, family);
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    // A deadline for the whole exchange, which a service sending a byte now and then cannot
    // stretch the way it stretches a socket idle timeout.
    const deadline = setTimeout(() => r.destroy(new Error("push timed out")), timeoutMs);
    r.on("close", () => clearTimeout(deadline));
    r.on("error", reject);
    r.end(req.body ?? undefined);
  });

/** Sends pushes with the server's own credentials, or through the relay. */
export class Push {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, { running: number; waiting: (() => void)[] }>();
  private fcmToken?: { value: string; expires: number };

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly resolve: (host: string) => Promise<string[]> = async (host) =>
      (await lookup(host, { all: true })).map((a) => a.address),
    private readonly pinned: PinnedSend = pinnedHttps,
  ) {}

  /**
   * The address to connect to for `url`, once every address its host resolves to is public;
   * undefined when one is private. The push then connects to that exact address, so a DNS
   * answer that changes in between cannot point it inward.
   */
  private async publicAddress(url: URL): Promise<string | undefined> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isPrivateHost(host)) return undefined;
    if (isIP(host)) return host;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      this.resolve(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("push host lookup timed out")),
          this.config.pushTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (addresses.length === 0 || addresses.some(isPrivateHost)) return undefined;
    return addresses[0];
  }

  /**
   * Pushes `payload(member)` to every subscription of each member of `types`, without waiting.
   * Each account has at most `ACCOUNT_CONCURRENCY` pushes in flight.
   */
  notify(
    account: string,
    members: string[],
    payload: (member: string) => string,
    types: PushType[] = PushType.options,
  ): void {
    if (members.length === 0) return;
    const subs = this.db
      .query(
        `SELECT id, member_id, type, endpoint, keys FROM push_subscriptions
         WHERE account_id = ? AND member_id IN (SELECT value FROM json_each(?))
           AND type IN (SELECT value FROM json_each(?))`,
      )
      .all(account, JSON.stringify(members), JSON.stringify(types)) as {
      id: string;
      member_id: string;
      type: PushType;
      endpoint: string;
      keys: string | null;
    }[];
    for (const s of subs) {
      const target: PushTarget = {
        type: s.type,
        endpoint: s.endpoint,
        keys: s.keys ? JSON.parse(s.keys) : undefined,
      };
      const body = payload(s.member_id);
      this.queue(account, async () => {
        const r = await this.send(target, body);
        if (r === "gone") this.db.query("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
      });
    }
  }

  private queue(account: string, job: () => Promise<void>): void {
    let q = this.queues.get(account);
    if (!q) {
      q = { running: 0, waiting: [] };
      this.queues.set(account, q);
    }
    if (q.waiting.length >= ACCOUNT_QUEUE) {
      console.error(`push queue full for account ${account}; dropping a push`);
      return;
    }
    const queue = q;
    this.track(
      new Promise<void>((done) => {
        queue.waiting.push(() => {
          queue.running += 1;
          job()
            .finally(() => {
              queue.running -= 1;
              this.next(account);
            })
            .then(done, (e) => {
              console.error("push failed:", e);
              done();
            });
        });
        this.next(account);
      }),
    );
  }

  private next(account: string): void {
    const q = this.queues.get(account);
    if (!q) return;
    while (q.running < ACCOUNT_CONCURRENCY && q.waiting.length > 0) q.waiting.shift()?.();
    if (q.running === 0 && q.waiting.length === 0) this.queues.delete(account);
  }

  /** Resolves once every push started so far has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    const q = p
      .catch((e) => console.error("push failed:", e))
      .finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  /**
   * Sends one push: directly when this server holds the credentials, else via the relay unless
   * `relay` is false (the relay itself never forwards onward).
   */
  async send(target: PushTarget, payload: string, relay = true): Promise<PushResult> {
    try {
      switch (target.type) {
        case "fcm":
          if (this.config.fcm) return await this.sendFcm(target.endpoint, payload);
          return relay ? await this.viaRelay(target, payload) : "no-route";
        case "webpush":
          if (this.config.vapid) return await this.sendWebPush(target, payload, true);
          return relay ? await this.viaRelay(target, payload) : "no-route";
        case "unifiedpush":
          return await this.sendWebPush(target, payload, false);
      }
    } catch (e) {
      console.error(`push to ${target.type} failed:`, e);
      return "failed";
    }
  }

  /** The VAPID public key browsers must subscribe with: ours, or the relay's. */
  async vapidPublicKey(): Promise<string | undefined> {
    if (this.config.vapid) return this.config.vapid.publicKey;
    if (!this.config.relayUrl) return undefined;
    const res = await this.fetchFn(`${this.config.relayUrl}/v1/push/vapid`, {
      signal: this.timeout(),
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { publicKey?: string }).publicKey;
  }

  private async viaRelay(target: PushTarget, payload: string): Promise<PushResult> {
    if (!this.config.relayUrl) return "no-route";
    const res = await this.fetchFn(`${this.config.relayUrl}/v1/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...target, payload }),
      signal: this.timeout(),
    });
    if (!res.ok) return "failed";
    const { result } = (await res.json()) as { result?: PushResult };
    return result ?? "failed";
  }

  private async sendWebPush(
    target: PushTarget,
    payload: string,
    vapid: boolean,
  ): Promise<PushResult> {
    let req: {
      method: string;
      headers: Record<string, string | number>;
      body: Buffer | null;
      endpoint: string;
    };
    if (target.keys) {
      req = webpush.generateRequestDetails(
        { endpoint: target.endpoint, keys: target.keys },
        payload,
        {
          TTL: 86_400,
          urgency: "high",
          ...(vapid && this.config.vapid ? { vapidDetails: this.config.vapid } : {}),
        },
      ) as typeof req;
    } else {
      // A UnifiedPush distributor without Web Push keys takes the payload as is.
      req = {
        method: "POST",
        headers: { TTL: 86_400 },
        body: Buffer.from(payload),
        endpoint: target.endpoint,
      };
    }
    const out: PushRequest = {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: req.body ? new Uint8Array(req.body) : null,
    };
    let status: number;
    if (this.config.allowPrivatePushEndpoints) {
      const res = await this.fetchFn(req.endpoint, {
        ...out,
        redirect: "manual",
        signal: this.timeout(),
      });
      status = res.status;
    } else {
      const url = new URL(req.endpoint);
      const address = await this.publicAddress(url);
      if (!address) {
        console.error(`push endpoint resolves to a private address: ${url.host}`);
        return "failed";
      }
      status = await this.pinned(url, address, out, this.config.pushTimeoutMs);
    }
    if (status === 404 || status === 410) return "gone";
    return status >= 200 && status < 300 ? "ok" : "failed";
  }

  private timeout(): AbortSignal {
    return AbortSignal.timeout(this.config.pushTimeoutMs);
  }

  private async sendFcm(token: string, payload: string): Promise<PushResult> {
    const fcm = this.config.fcm;
    if (!fcm) return "no-route";
    const res = await this.fetchFn(`${fcm.apiUrl}/v1/projects/${fcm.projectId}/messages:send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.fcmAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: { token, data: { p: payload }, android: { priority: "HIGH", ttl: "86400s" } },
      }),
      signal: this.timeout(),
    });
    if (res.ok) return "ok";
    const text = await res.text();
    if (res.status === 404 || text.includes("UNREGISTERED")) return "gone";
    if (res.status === 401) this.fcmToken = undefined;
    return "failed";
  }

  /** An OAuth access token for the service account (a JWT bearer grant, RFC 7523). */
  private async fcmAccessToken(): Promise<string> {
    const fcm = this.config.fcm;
    if (!fcm) throw new Error("no FCM credentials");
    const now = Math.floor(Date.now() / 1000);
    if (this.fcmToken && this.fcmToken.expires > now + 60) return this.fcmToken.value;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
      iss: fcm.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: fcm.tokenUrl,
      iat: now,
      exp: now + 3600,
    })}`;
    const der = Buffer.from(fcm.privateKey.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(unsigned));
    const res = await this.fetchFn(fcm.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${Buffer.from(sig).toString("base64url")}`,
      }),
      signal: this.timeout(),
    });
    if (!res.ok) throw new Error(`FCM token request: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.fcmToken = { value: body.access_token, expires: now + body.expires_in };
    return body.access_token;
  }
}
