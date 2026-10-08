/** starbridge.run unless the owner chose another server. */
export const DEFAULT_SERVER = "https://starbridge.run";

/**
 * The origin of a server the owner typed, or null. HTTPS only, except on this machine, where a
 * self-hoster or a test runs it over plain HTTP.
 */
export function serverOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.origin;
}

/** Whether the window may show `url`: the server's pages only; GitHub signs in in the browser. */
export function staysInWindow(url: string, origin: string): boolean {
  return originOf(url) === origin;
}

/** Whether a link the window will not show may open in the owner's browser. */
export function opensOutside(url: string): boolean {
  const p = protocolOf(url);
  return p === "https:" || p === "http:" || p === "mailto:";
}

/**
 * The server page a `starbridge://` link opens, or why not. `starbridge://pair?server=…#<code>`
 * opens `/pair#<code>` on the configured server. The check key (`k`) stays out of the page: it
 * proves the machine to the Android app without the server, and the page comes from the server.
 */
export function linkPage(
  link: string,
  origin: string,
): { url: string } | { refused: string } | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "starbridge:" || url.hostname !== "pair") return null;
  const code = url.hash.slice(1);
  if (!/^[0-9A-Za-z-]{1,64}$/.test(code)) return null;
  const server = url.searchParams.get("server");
  const target = server === null ? origin : serverOrigin(server);
  if (target !== origin)
    return { refused: `This pairing link is for ${server}, and Starbridge uses ${origin}.` };
  return { url: `${origin}/pair#${code}` };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}
