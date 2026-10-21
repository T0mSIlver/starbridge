import type { Metadata } from "next";

/**
 * The server's session cookie (server/src/auth.ts, `cookieName`): `__Host-sb_session` on https,
 * the bare name on http or from a session started before the prefix. A request with neither is a
 * visitor's.
 */
const SESSION_COOKIES = ["__Host-sb_session", "sb_session"];

/** Whether a request's cookies hold a session, which makes it no visitor's. */
export function hasSession(jar: { has(name: string): boolean }): boolean {
  return SESSION_COOKIES.some((name) => jar.has(name));
}

/**
 * Set by the desktop app in its own window (desktop/src/main.ts): its signed-out page is sign-in,
 * never the landing page (#905).
 */
export const DESKTOP_COOKIE = "sb_desktop";

export const DESCRIPTION =
  "When a coding agent stops for a question, your phone tells you. Answer with one tap and it gets back to work. Every agent and machine in one place. Open source, end-to-end encrypted.";

/**
 * The page's origin as the visitor typed it, for the absolute URLs link previews need. A reverse
 * proxy passes it in X-Forwarded-*, which Caddy sets itself (deploy/Caddyfile).
 */
export function origin(headers: Headers): string {
  const first = (name: string) => headers.get(name)?.split(",")[0]?.trim();
  return `${first("x-forwarded-proto") ?? "http"}://${first("x-forwarded-host") ?? first("host")}`;
}

/**
 * The origin the landing page's cache keys on (#1722), else undefined, and the request renders
 * without it. With PUBLIC_URL set, only that origin; without, a forwarded host must be the
 * request's own Host, which the reverse proxy routes on, since a proxy in front of it (Cloudflare)
 * passes X-Forwarded-Host on as the client sent it. Forged hosts would otherwise fill the cache's
 * few slots, and every later visitor's page would render in full.
 */
export function cacheOrigin(headers: Headers, publicUrl?: string): string | undefined {
  const base = origin(headers);
  if (publicUrl) {
    try {
      const fixed = new URL(publicUrl).origin;
      return base === fixed ? fixed : undefined;
    } catch {
      return undefined;
    }
  }
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return forwarded === undefined || forwarded === headers.get("host") ? base : undefined;
}

/** The landing page's title, description and link preview, at `/` for a visitor (#694). */
export function landingMetadata(base: string): Metadata {
  const title = "Starbridge · Answer your coding agents from your phone";
  return {
    metadataBase: new URL(base),
    title: { absolute: title },
    description: DESCRIPTION,
    openGraph: {
      type: "website",
      siteName: "Starbridge",
      url: "/",
      title,
      description: DESCRIPTION,
      // web/scripts/og-image.ts draws it.
      images: [
        {
          url: "/og.png",
          width: 1200,
          height: 630,
          alt: "Know the moment your agent is stuck: the Starbridge inbox on a phone",
        },
      ],
    },
    twitter: { card: "summary_large_image" },
  };
}
