// A `/pair#<code>` link opened while this browser is signed out or not yet a device. The code
// waits in this tab's sessionStorage, which outlives the GitHub sign-in round trip and never
// reaches the server, and the Devices page takes it once the browser is a device.
const KEY = "starbridge.pair";
/** A pairing code expires after 10 minutes. */
const TTL_MS = 10 * 60_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStore(): Store | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

/** Moves the code of a `/pair#<code>` address into the tab's storage, off the address bar. */
export function holdPairCode(store = tabStore(), now = Date.now()) {
  if (location.pathname !== "/pair" || location.hash.length < 2) return;
  const code = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  try {
    store?.setItem(KEY, JSON.stringify({ code, at: now }));
  } catch {}
}

function read(store: Store | undefined, now: number): string | undefined {
  try {
    const held = JSON.parse(store?.getItem(KEY) ?? "null") as { code: string; at: number } | null;
    if (held && now - held.at < TTL_MS) return held.code;
    store?.removeItem(KEY);
  } catch {}
  return undefined;
}

export function hasPairCode(store = tabStore(), now = Date.now()): boolean {
  return read(store, now) !== undefined;
}

/** The held code, once: taking it clears it. */
export function takePairCode(store = tabStore(), now = Date.now()): string | undefined {
  const code = read(store, now);
  try {
    store?.removeItem(KEY);
  } catch {}
  return code;
}
