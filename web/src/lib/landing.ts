import type { Metadata } from "next";

/** The server's session cookie (server/src/auth.ts): a request without it is a visitor's. */
export const SESSION_COOKIE = "sb_session";

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
