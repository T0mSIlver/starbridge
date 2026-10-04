import type { Database } from "bun:sqlite";
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
 * server call into its own network. Names that resolve to private addresses are not caught.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
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

/** Sends pushes with the server's own credentials, or through the relay. */
export class Push {
  private readonly pending = new Set<Promise<unknown>>();
  private fcmToken?: { value: string; expires: number };

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Pushes `payload(member)` to every subscription of each member, without waiting. */
  notify(account: string, members: string[], payload: (member: string) => string): void {
    if (members.length === 0) return;
    const subs = this.db
      .query(
        `SELECT id, member_id, type, endpoint, keys FROM push_subscriptions
         WHERE account_id = ? AND member_id IN (SELECT value FROM json_each(?))`,
      )
      .all(account, JSON.stringify(members)) as {
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
      this.track(
        this.send(target, payload(s.member_id)).then((r) => {
          if (r === "gone") this.db.query("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
        }),
      );
    }
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
    const res = await this.fetchFn(`${this.config.relayUrl}/v1/push/vapid`);
    if (!res.ok) return undefined;
    return ((await res.json()) as { publicKey?: string }).publicKey;
  }

  private async viaRelay(target: PushTarget, payload: string): Promise<PushResult> {
    if (!this.config.relayUrl) return "no-route";
    const res = await this.fetchFn(`${this.config.relayUrl}/v1/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...target, payload }),
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
    const res = await this.fetchFn(req.endpoint, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: req.body ? new Uint8Array(req.body) : null,
      redirect: "manual",
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "failed";
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
    });
    if (!res.ok) throw new Error(`FCM token request: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.fcmToken = { value: body.access_token, expires: now + body.expires_in };
    return body.access_token;
  }
}
