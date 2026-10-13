import { createHash, createPublicKey, verify } from "node:crypto";
import type { Config } from "./config";

export type AppleConfig = NonNullable<Config["apple"]>;

const ISSUER = "https://appleid.apple.com";
/** Apple rotates its keys rarely; a token signed by a key not cached yet refetches them. */
const KEYS_TTL_MS = 3_600_000;
/** Apple takes a client secret for up to 6 months; one lasts the server's day. */
const SECRET_LIFETIME_S = 86_400;
/** Leeway for the clocks of Apple and this server. */
const SKEW_S = 60;

export interface AppleIdentity {
  /** Apple's stable user id for this team. */
  sub: string;
  /** The `nonce` claim, as the client sent it to Apple. */
  nonce?: string;
}

/** Thrown for a token or code Apple did not issue for this server, or no longer honours. */
export class AppleRefused extends Error {}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Apple's side of Sign in with Apple: verifies identity tokens against Apple's keys, trades
 * authorization codes for refresh tokens, and revokes them when an account goes (App Store
 * 5.1.1(v)).
 */
export class Apple {
  private keys?: { at: number; byKid: Map<string, JsonWebKey> };
  private readonly revoking = new Set<Promise<void>>();
  private readonly secrets = new Map<string, { value: Promise<string>; madeAt: number }>();

  constructor(
    private readonly config: AppleConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Checks an identity token: Apple's signature, issuer, expiry, and an audience among
   * `audiences`. With `nonce`, the token must carry its SHA-256 in hex, as AuthenticationServices
   * and Apple's JS put it there.
   */
  async verify(token: string, audiences: string[], nonce?: string): Promise<AppleIdentity> {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) throw new AppleRefused("not a JWT");
    const head = parse(h) as { alg?: string; kid?: string };
    if (head.alg !== "RS256" || typeof head.kid !== "string") throw new AppleRefused("bad header");
    const jwk = await this.key(head.kid);
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(s, "base64url"),
    );
    if (!ok) throw new AppleRefused("bad signature");
    const claims = parse(p) as {
      iss?: string;
      aud?: string;
      exp?: number;
      sub?: string;
      nonce?: string;
    };
    const now = Date.now() / 1000;
    if (claims.iss !== ISSUER) throw new AppleRefused("not Apple's");
    if (!claims.aud || !audiences.includes(claims.aud)) throw new AppleRefused("not ours");
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now)
      throw new AppleRefused("expired");
    if (typeof claims.sub !== "string" || !claims.sub) throw new AppleRefused("no subject");
    if (nonce !== undefined && claims.nonce !== sha256hex(nonce))
      throw new AppleRefused("nonce does not match");
    return { sub: claims.sub, nonce: claims.nonce };
  }

  /**
   * Trades an authorization code issued to `clientId` for Apple's tokens. The identity token in
   * the answer is checked as any other; a code Apple refuses is `AppleRefused`.
   */
  async exchange(
    clientId: string,
    code: string,
    redirectUri?: string,
  ): Promise<{ identity: AppleIdentity; refreshToken: string }> {
    const res = await this.post("/auth/token", {
      client_id: clientId,
      client_secret: await this.clientSecret(clientId),
      code,
      grant_type: "authorization_code",
      ...(redirectUri && { redirect_uri: redirectUri }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id_token?: string;
      refresh_token?: string;
      error?: string;
    };
    if (res.status === 400 && body.error === "invalid_grant")
      throw new AppleRefused("code unknown, used or expired");
    if (!res.ok || !body.id_token || !body.refresh_token)
      throw new Error(`Apple token endpoint answered ${res.status} ${body.error ?? ""}`);
    return {
      identity: await this.verify(body.id_token, [clientId]),
      refreshToken: body.refresh_token,
    };
  }

  /**
   * Revokes a refresh token, so Apple lists Starbridge no more under the user's Apple ID. It runs
   * after the reply, and [idle] lets a shutdown wait for it: the token is gone from the database
   * by then, so nothing could retry it.
   */
  revoke(clientId: string, refreshToken: string): void {
    const p = (async () => {
      const res = await this.post("/auth/revoke", {
        client_id: clientId,
        client_secret: await this.clientSecret(clientId),
        token: refreshToken,
        token_type_hint: "refresh_token",
      });
      if (!res.ok) throw new Error(`Apple revoke answered ${res.status}`);
    })()
      .catch((e) => console.error(`Apple revoke on account deletion: ${e}`))
      .finally(() => this.revoking.delete(p));
    this.revoking.add(p);
  }

  /** Resolves once every revocation started so far has settled. */
  async idle(): Promise<void> {
    while (this.revoking.size > 0) await Promise.allSettled([...this.revoking]);
  }

  private post(path: string, form: Record<string, string>): Promise<Response> {
    return this.fetchFn(`${this.config.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async key(kid: string): Promise<JsonWebKey> {
    const fresh = this.keys && Date.now() - this.keys.at < KEYS_TTL_MS;
    let jwk = fresh ? this.keys?.byKid.get(kid) : undefined;
    if (jwk) return jwk;
    const res = await this.fetchFn(`${this.config.url}/auth/keys`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Apple keys answered ${res.status}`);
    const { keys = [] } = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    this.keys = { at: Date.now(), byKid: new Map(keys.map((k) => [k.kid ?? "", k])) };
    jwk = this.keys.byKid.get(kid);
    if (!jwk) throw new AppleRefused("unknown key");
    return jwk;
  }

  /**
   * The client secret Apple's token and revoke endpoints take: a JWT signed with the team's Sign
   * in with Apple key, whose subject is the client id, the App ID's or the Services ID's.
   */
  private clientSecret(clientId: string): Promise<string> {
    const now = Date.now();
    const cached = this.secrets.get(clientId);
    if (cached && now - cached.madeAt < (SECRET_LIFETIME_S / 2) * 1000) return cached.value;
    const made = { value: this.sign(clientId, now), madeAt: now };
    this.secrets.set(clientId, made);
    made.value.catch(() => {
      if (this.secrets.get(clientId) === made) this.secrets.delete(clientId);
    });
    return made.value;
  }

  private async sign(clientId: string, now: number): Promise<string> {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const iat = Math.floor(now / 1000);
    const unsigned = `${enc({ alg: "ES256", kid: this.config.keyId })}.${enc({
      iss: this.config.teamId,
      iat,
      exp: iat + SECRET_LIFETIME_S,
      aud: ISSUER,
      sub: clientId,
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

function parse(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString());
  } catch {
    throw new AppleRefused("not a JWT");
  }
}
