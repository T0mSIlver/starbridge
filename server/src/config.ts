import { type ClientName, isMinimumRelease } from "@starbridge/protocol";
import { MINIMUM_RELEASES } from "./clients";
import { DEFAULT_LIMITS, type Limits } from "./limits";

/** Everything the server reads from its environment. Tests build this object directly. */
export interface Config {
  port: number;
  /** SQLite file; ":memory:" in tests. */
  dbPath: string;
  /** Public origin of this server, for OAuth redirects, e.g. "https://starbridge.example". */
  publicUrl: string;
  /** Marks the session cookie Secure; off only for plain-HTTP local runs. */
  secureCookies: boolean;
  /** Read the client IP from X-Forwarded-For (behind Caddy). */
  trustProxy: boolean;

  github?: {
    clientId: string;
    clientSecret: string;
    authorizeUrl: string;
    tokenUrl: string;
    apiUrl: string;
  };
  /** Self-hosted sign-in: whoever presents this token owns the server's one account. */
  ownerToken?: string;
  /** Where the GitHub callback sends the Android app, with a code it trades for a session. */
  appRedirectUri: string;

  /** Most machines an account may hold at once. */
  maxMachines: number;
  /** Upper bound on `wait` for the answer and pairing long-polls, in seconds. */
  maxWaitSeconds: number;
  /** Pushes carry the device's box when the payload stays within this many bytes. */
  pushInlineLimit: number;
  /**
   * Private hosts push subscriptions may point at, over HTTP too (a self-hoster's own ntfy), as
   * `pushHostKey` writes them; "any" for every private host, the old yes/no flag's meaning.
   */
  privatePushHosts: PrivatePushHosts;
  /** Gives up on one request to a push service after this many milliseconds. */
  pushTimeoutMs: number;

  fcm?: {
    projectId: string;
    clientEmail: string;
    /** PKCS#8 PEM. */
    privateKey: string;
    tokenUrl: string;
    apiUrl: string;
  };
  vapid?: { publicKey: string; privateKey: string; subject: string };
  /** The team's APNs auth key, for the iPhone app. */
  apns?: {
    keyId: string;
    teamId: string;
    /** The .p8 file's PKCS#8 PEM. */
    privateKey: string;
    /** The app's bundle id. */
    topic: string;
    url: string;
    sandboxUrl: string;
  };
  /** Forward FCM, APNs and Web Push to this relay when the server has no credentials of its own. */
  relayUrl?: string;
  /** Serve `POST /v1/relay` for other servers. */
  relayMode: boolean;
  /**
   * The demo server for Play reviewers (#423): serves `GET /v1/demo`, which the demo program
   * (`demo/`) needs before it approves joins unseen. Refused wherever the hosted service runs.
   */
  demo: boolean;
  /**
   * A second port serving `GET /watch`, the launch watcher's counts (server/src/watch.ts). Off
   * unless set: it names addresses, so only the host may reach it (deploy/compose.yaml).
   */
  watchPort?: number;
  /**
   * Umami, where the server posts the launch funnel's steps (server/src/funnel.ts): its base URL
   * and the website's id. Off unless both are set; only starbridge.run sets them.
   */
  umami?: { url: string; websiteId: string };
  /** The commit this server was built from, which /healthz names. */
  revision?: string;
  /** Rate limits, caps and retention; tests lower them. */
  limits: Limits;
  /** The oldest release served per client (`MINIMUM_RELEASES`); tests set their own. */
  minimumReleases: Partial<Record<ClientName, string>>;
}

type Env = Record<string, string | undefined>;

export type PrivatePushHosts = "any" | string[];

/** A URL's host as `privatePushHosts` lists it: lowercase, no brackets or trailing dot. */
export const pushHostKey = (host: string) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");

/**
 * `ALLOW_PRIVATE_PUSH_ENDPOINTS`: a comma-separated list of hosts. `1` or `true`, from before the
 * list, still allows every private host, which `main.ts` warns about.
 */
export function privatePushHosts(v: string | undefined): PrivatePushHosts {
  if (flag(v)) return "any";
  return (v ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h && h !== "0" && h !== "false")
    .map(canonicalHost);
}

/** `host` as a URL names it, so `fd00:0::1` or `010.0.0.1` matches the endpoints that use it. */
function canonicalHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  let url: URL | undefined;
  try {
    url = new URL(`http://${bare.includes(":") ? `[${bare}]` : bare}/`);
  } catch {}
  if (!url || url.port || url.username || `${url.pathname}${url.search}${url.hash}` !== "/")
    throw new Error(`ALLOW_PRIVATE_PUSH_ENDPOINTS: not a host name or address: ${host}`);
  return pushHostKey(url.hostname);
}

function flag(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

function int(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === "" ? fallback : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`not a non-negative integer: ${v}`);
  return n;
}

export function configFromEnv(env: Env = process.env): Config {
  const port = int(env.PORT, 8080);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const config: Config = {
    port,
    dbPath: env.DB_PATH ?? "./data/starbridge.db",
    publicUrl,
    secureCookies: publicUrl.startsWith("https://"),
    trustProxy: flag(env.TRUST_PROXY),
    github:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            authorizeUrl: env.GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize",
            tokenUrl: env.GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token",
            apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
          }
        : undefined,
    ownerToken: env.OWNER_TOKEN || undefined,
    appRedirectUri: env.APP_REDIRECT_URI ?? "starbridge://auth",
    maxMachines: int(env.MAX_MACHINES, 5),
    maxWaitSeconds: int(env.MAX_WAIT_SECONDS, 300),
    pushInlineLimit: int(env.PUSH_INLINE_LIMIT, 3072),
    privatePushHosts: privatePushHosts(env.ALLOW_PRIVATE_PUSH_ENDPOINTS),
    pushTimeoutMs: int(env.PUSH_TIMEOUT_MS, 10_000),
    fcm:
      env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY
        ? {
            projectId: env.FCM_PROJECT_ID,
            clientEmail: env.FCM_CLIENT_EMAIL,
            privateKey: env.FCM_PRIVATE_KEY.replace(/\\n/g, "\n"),
            tokenUrl: env.FCM_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
            apiUrl: env.FCM_API_URL ?? "https://fcm.googleapis.com",
          }
        : undefined,
    vapid:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT ?? publicUrl,
          }
        : undefined,
    apns:
      env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY
        ? {
            keyId: env.APNS_KEY_ID,
            teamId: env.APNS_TEAM_ID,
            privateKey: env.APNS_PRIVATE_KEY.replace(/\\n/g, "\n"),
            topic: env.APNS_TOPIC ?? "dev.starbridge.ios",
            url: env.APNS_URL ?? "https://api.push.apple.com",
            sandboxUrl: env.APNS_SANDBOX_URL ?? "https://api.sandbox.push.apple.com",
          }
        : undefined,
    relayUrl: env.RELAY_URL?.replace(/\/$/, "") || undefined,
    relayMode: flag(env.RELAY_MODE),
    demo: flag(env.DEMO),
    watchPort: env.WATCH_PORT ? int(env.WATCH_PORT, 0) : undefined,
    umami:
      env.UMAMI_URL && env.UMAMI_WEBSITE_ID
        ? { url: env.UMAMI_URL.replace(/\/$/, ""), websiteId: env.UMAMI_WEBSITE_ID }
        : undefined,
    revision: env.STARBRIDGE_REVISION || undefined,
    limits: DEFAULT_LIMITS,
    minimumReleases: MINIMUM_RELEASES,
  };
  // The relay pushes for anyone who asks; private endpoints are for a self-hoster's own devices.
  if (config.relayMode && config.privatePushHosts.length)
    throw new Error("RELAY_MODE is refused with ALLOW_PRIVATE_PUSH_ENDPOINTS");
  if (config.demo) checkDemo(config);
  for (const [name, minimum] of Object.entries(config.minimumReleases))
    if (!isMinimumRelease(minimum))
      throw new Error(`minimum ${name} release: not MAJOR.MINOR.PATCH`);
  return config;
}

/**
 * A demo server approves every join, so it must never be the hosted one: prod sets
 * PUBLIC_URL to starbridge.run, GitHub sign-in and relay mode, and any one of them refuses DEMO.
 */
export function checkDemo(config: Config): void {
  const host = new URL(config.publicUrl).hostname;
  const problem =
    (host === "starbridge.run" || host.endsWith(".starbridge.run")) &&
    host !== "demo.starbridge.run"
      ? `PUBLIC_URL ${config.publicUrl}`
      : config.github
        ? "GitHub sign-in"
        : config.relayMode
          ? "RELAY_MODE"
          : !config.ownerToken
            ? "no OWNER_TOKEN"
            : undefined;
  if (problem) throw new Error(`DEMO=1 is refused with ${problem}`);
}
