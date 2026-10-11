import { type ClientHttp2Session, connect } from "node:http2";
import type { Config } from "./config";
import type { PushResult } from "./push";

export type ApnsConfig = NonNullable<Config["apns"]>;
export type ApnsEnvironment = "production" | "sandbox";

/** APNs refuses a payload over 4 KB. */
const MAX_PAYLOAD = 4096;
/** Pushes not delivered within a day are dropped, as FCM's ttl drops them on Android. */
const EXPIRY_SECONDS = 86_400;
/** APNs takes a provider token for up to an hour and refuses a new one within 20 minutes. */
const TOKEN_LIFETIME_MS = 50 * 60_000;

/** What a device shows until its notification service extension opens the box. */
const PLACEHOLDERS: Record<string, { category: string; body: string }> = {
  decision: { category: "decision", body: "A question needs you" },
  waiting: { category: "decision", body: "A question needs you" },
  snooze: { category: "decision", body: "A question needs you" },
  permission: { category: "permission", body: "A permission prompt needs you" },
  join: { category: "join", body: "A device wants to join" },
};

export interface ApnsRequest {
  headers: Record<string, string>;
  body: string;
}

/**
 * The APNs request for one push payload (PROTOCOL.md, "Push"). What asks for the owner goes as
 * an alert with `mutable-content`, so the app's notification service extension replaces the
 * placeholder with what the box says; the payload rides in `p` as JSON. What only closes or
 * hides a notification (`answered`, a settled notice, a snooze as it is posted) goes as a
 * background push, which iOS may hold or drop: the app syncs when it opens. `thread` is the machine
 * an item from a device is about: a snooze's return groups under the question's machine (#1168).
 */
export function apnsRequest(
  payload: string,
  topic: string,
  now = Date.now(),
  thread?: string,
): ApnsRequest {
  const head = JSON.parse(payload) as {
    kind: string;
    id: string;
    from?: string;
    re?: string;
    wakeAt?: string;
    box?: string;
  };
  // A snooze pushes twice: as it is posted, to hide the question, and at its wakeAt, to show it
  // again (PROTOCOL.md, "Snoozing").
  const hides = head.kind === "snooze" && head.wakeAt && Date.parse(head.wakeAt) > now;
  const shown = hides ? undefined : PLACEHOLDERS[head.kind];
  const headers: Record<string, string> = {
    "apns-topic": topic,
    "apns-expiration": String(Math.floor(now / 1000) + EXPIRY_SECONDS),
  };
  let aps: Record<string, unknown>;
  if (shown) {
    // One notification per question: a waiting flip or a snooze's return replaces it.
    const collapse = head.kind === "waiting" || head.kind === "snooze" ? head.re : head.id;
    headers["apns-push-type"] = "alert";
    headers["apns-priority"] = "10";
    if (collapse && Buffer.byteLength(collapse) <= 64) headers["apns-collapse-id"] = collapse;
    aps = {
      alert: { title: "Starbridge", body: shown.body },
      sound: "default",
      "mutable-content": 1,
      category: shown.category,
      // Grouped by machine; a join comes from no machine.
      "thread-id": head.kind === "join" ? "join" : (thread ?? head.from ?? "starbridge"),
    };
  } else {
    // APNs refuses priority 10 for a background push.
    headers["apns-push-type"] = "background";
    headers["apns-priority"] = "5";
    aps = { "content-available": 1 };
  }
  let body = JSON.stringify({ aps, p: head });
  if (Buffer.byteLength(body) > MAX_PAYLOAD) {
    // The device fetches the item instead, as for any payload over the inline limit.
    const { box: _, ...rest } = head;
    body = JSON.stringify({ aps, p: rest });
  }
  return { headers, body };
}

interface Response {
  status: number;
  reason?: string;
}

/** Sends pushes to APNs over HTTP/2 with a token signed by the team's auth key (.p8). */
export class Apns {
  /** The token being made or made, shared so concurrent sends never mint one each. */
  private token?: { value: Promise<string>; madeAt: number };
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(
    private readonly config: ApnsConfig,
    private readonly timeoutMs: number,
  ) {}

  /**
   * `gone` only when APNs says the token is dead in the environment the device named and in the
   * other one too: a debug build's sandbox token sent to production is `BadDeviceToken` there,
   * and dropping its subscription for that would silence a device that works (the lesson of
   * #1011). Every other refusal, a timeout or an outage keeps the subscription.
   */
  async send(
    token: string,
    environment: ApnsEnvironment,
    payload: string,
    thread?: string,
  ): Promise<PushResult> {
    const req = apnsRequest(payload, this.config.topic, Date.now(), thread);
    const first = await this.post(environment, token, req);
    if (first.status === 200) return "ok";
    if (first.status === 410) return "gone";
    if (first.reason !== "BadDeviceToken") return "failed";
    const other = environment === "production" ? "sandbox" : "production";
    const second = await this.post(other, token, req);
    if (second.status === 200) return "ok";
    return second.status === 410 || second.reason === "BadDeviceToken" ? "gone" : "failed";
  }

  /** Closes the open connections. */
  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private async post(
    environment: ApnsEnvironment,
    token: string,
    req: ApnsRequest,
  ): Promise<Response> {
    const origin = environment === "production" ? this.config.url : this.config.sandboxUrl;
    const res = await this.request(
      origin,
      `/3/device/${token}`,
      {
        ...req.headers,
        authorization: `bearer ${await this.providerToken()}`,
      },
      req.body,
    );
    let reason: string | undefined;
    try {
      reason = res.body ? (JSON.parse(res.body) as { reason?: string }).reason : undefined;
    } catch {}
    if (res.status === 403 && reason === "ExpiredProviderToken") this.token = undefined;
    if (res.status !== 200) console.error(`APNs ${environment}: ${res.status} ${reason ?? ""}`);
    return { status: res.status, reason };
  }

  /** One HTTP/2 connection per origin, kept open as Apple asks, and opened again once it ends. */
  private session(origin: string): ClientHttp2Session {
    const open = this.sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(origin);
    // The server process may exit with the connection open.
    s.unref();
    const drop = () => {
      if (this.sessions.get(origin) === s) this.sessions.delete(origin);
    };
    s.on("error", (e) => {
      console.error("APNs connection:", e);
      drop();
    });
    s.on("goaway", drop);
    s.on("close", drop);
    this.sessions.set(origin, s);
    return s;
  }

  private request(
    origin: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const s = this.session(origin);
      const r = s.request({ ":method": "POST", ":path": path, ...headers });
      let status = 0;
      let text = "";
      const deadline = setTimeout(() => {
        // A connection that stopped answering takes the next push with it: open a new one.
        s.destroy();
        reject(new Error("APNs timed out"));
      }, this.timeoutMs);
      r.setEncoding("utf8");
      r.on("response", (h) => {
        status = Number(h[":status"]);
      });
      r.on("data", (d: string) => {
        text += d;
      });
      r.on("end", () => {
        clearTimeout(deadline);
        resolve({ status, body: text });
      });
      r.on("error", (e) => {
        clearTimeout(deadline);
        reject(e);
      });
      r.end(body);
    });
  }

  /** The JWT APNs takes as a provider token: ES256, signed with the team's auth key. */
  private providerToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now - this.token.madeAt < TOKEN_LIFETIME_MS) return this.token.value;
    const token = { value: this.signToken(now), madeAt: now };
    this.token = token;
    token.value.catch(() => {
      if (this.token === token) this.token = undefined;
    });
    return token.value;
  }

  private async signToken(now: number): Promise<string> {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "ES256", kid: this.config.keyId })}.${enc({
      iss: this.config.teamId,
      iat: Math.floor(now / 1000),
    })}`;
    const der = Buffer.from(this.config.privateKey.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    // WebCrypto signs ECDSA as r || s, the form JWS wants.
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(unsigned),
    );
    return `${unsigned}.${Buffer.from(sig).toString("base64url")}`;
  }
}
