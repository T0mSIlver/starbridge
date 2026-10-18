/**
 * The format of what this app keeps in localStorage, written as `v` (#473); a later format raises
 * it and reads the ones before.
 */
const STORED_VERSION = 1;

/**
 * Reads a JSON object kept under `key`. A value this page cannot read (not JSON, not an object,
 * without a format, or a newer one) is logged, and the page runs on its defaults: `null`. Only a
 * newer format is left in place (`writable`).
 */
export function readStored(key: string, raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("not an object");
    const { v, ...rest } = value as Record<string, unknown>;
    if (v === undefined) throw new Error("no format");
    if (v !== STORED_VERSION) throw new Error(`format ${String(v)}, from a newer Starbridge`);
    return rest;
  } catch (e) {
    console.warn(`starbridge: ${key} unreadable (${(e as Error).message}); using defaults`);
    return null;
  }
}

/** Whether `raw` may be replaced: anything but a format this page does not read. */
export function writable(raw: string | null): boolean {
  if (raw === null) return true;
  try {
    const v = (JSON.parse(raw) as { v?: unknown } | null)?.v;
    return v === undefined || v === STORED_VERSION;
  } catch {
    return true;
  }
}

/** `value` as kept under a key: with its format. */
export function stored(value: object): string {
  return JSON.stringify({ v: STORED_VERSION, ...value });
}

/**
 * Every localStorage key that holds an account's data, so signing out removes them all. The
 * display prefs (`starbridge:prefs`: theme, grouping, widths) are not here: they say nothing of
 * the account, and a browser keeps its theme across accounts. A new key for account data goes
 * here, or stored.test.ts fails (#2014).
 */
export const ACCOUNT_STORAGE_KEYS = {
  /** Which providers and windows the owner alerts on. */
  quotaSettings: "starbridge:quota-settings",
  /** The account id that held quotas, for the Quotas tab's first frame. */
  quotaAccount: "starbridge:quota-account",
  /** The quota alerts shown, by snapshot, provider and window. */
  quotaNotified: "starbridge:quota-notified",
  /** The run ids notified. */
  runNotified: "starbridge:run-notified",
} as const;
