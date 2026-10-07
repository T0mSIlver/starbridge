// The service worker imports device.ts, so this module uses nothing from the DOM.
/**
 * The host of a pairing link made on a server other than `here`, or undefined for a bare code or
 * a link to `here` (#671). Asked only once the lookup failed: a server can answer on several
 * names, and a link under another of them still pairs.
 */
export function otherServer(text: string, here: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.host === here ? undefined : url.host;
}
