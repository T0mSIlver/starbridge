// Umami, self-hosted beside the server (deploy/compose.yaml): cookieless page analytics for
// the public pages only, never the signed-in app (SPEC.md, #141).

/** Umami's id for starbridge.run; deploy/umami-setup.sh creates the website with it. */
export const WEBSITE_ID = "f3741d82-c450-47d3-8845-646cddbe392f";

/** Caddy sends /stats/script.js and /stats/api/send to Umami (deploy/Caddyfile). */
export const SCRIPT = "/stats/script.js";

/**
 * Whether this build loads Umami: only starbridge.run's, whose compose file sets
 * NEXT_PUBLIC_ANALYTICS at build time. A self-hosted build has no Umami behind /stats, so the
 * script would 404 on every page.
 */
export function analyticsOn(): boolean {
  return process.env.NEXT_PUBLIC_ANALYTICS === "umami";
}

declare global {
  interface Window {
    umami?: { track: (event?: string, data?: Record<string, string>) => Promise<void> };
  }
}

/** Records an event, or the page view with no event; a no-op where the tracker did not load. */
export function track(event?: string, data?: Record<string, string>) {
  window.umami?.track(event, data);
}
