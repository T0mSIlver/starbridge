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
  /** Let push subscriptions point at private addresses (a self-hoster's own ntfy). */
  allowPrivatePushEndpoints: boolean;

  fcm?: {
    projectId: string;
    clientEmail: string;
    /** PKCS#8 PEM. */
    privateKey: string;
    tokenUrl: string;
    apiUrl: string;
  };
  vapid?: { publicKey: string; privateKey: string; subject: string };
  /** Forward FCM and Web Push to this relay when the server has no credentials of its own. */
  relayUrl?: string;
  /** Serve `POST /v1/relay` for other servers. */
  relayMode: boolean;
}

type Env = Record<string, string | undefined>;

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
  return {
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
    allowPrivatePushEndpoints: flag(env.ALLOW_PRIVATE_PUSH_ENDPOINTS),
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
    relayUrl: env.RELAY_URL?.replace(/\/$/, "") || undefined,
    relayMode: flag(env.RELAY_MODE),
  };
}
