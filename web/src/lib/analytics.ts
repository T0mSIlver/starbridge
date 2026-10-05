// Umami, self-hosted beside the server (deploy/compose.yaml): cookieless page analytics for
// the public pages only, never the signed-in app (SPEC.md, #141).

/** Umami's id for starbridge.run; deploy/umami-setup.sh creates the website with it. */
export const WEBSITE_ID = "f3741d82-c450-47d3-8845-646cddbe392f";

/** Caddy sends /stats/script.js and /stats/api/send to Umami (deploy/Caddyfile). */
export const SCRIPT = "/stats/script.js";

declare global {
  interface Window {
    umami?: { track: (event?: string, data?: Record<string, string>) => Promise<void> };
  }
}

/** Records an event, or the page view with no event; a no-op where the tracker did not load. */
export function track(event?: string, data?: Record<string, string>) {
  window.umami?.track(event, data);
}
