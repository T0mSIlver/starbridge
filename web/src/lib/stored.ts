/**
 * The format of what this app keeps in localStorage, written as `v` (#473). A value without `v`
 * is format 1; a later format raises it and reads the ones before.
 */
export const STORED_VERSION = 1;

/**
 * Reads a JSON object kept under `key`. A value this page cannot read (not JSON, not an object,
 * or a newer format) is logged and left in place, and the page runs on its defaults: `null`.
 */
export function readStored(key: string, raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("not an object");
    const { v = 1, ...rest } = value as Record<string, unknown>;
    if (v !== STORED_VERSION) throw new Error(`format ${String(v)}, from a newer Starbridge`);
    return rest;
  } catch (e) {
    console.warn(`starbridge: ${key} unreadable (${(e as Error).message}); using defaults`);
    return null;
  }
}

/** Whether `raw` may be replaced: absent, or in a format this page reads. */
export function writable(raw: string | null): boolean {
  if (raw === null) return true;
  try {
    const v = (JSON.parse(raw) as { v?: unknown } | null)?.v ?? 1;
    return v === STORED_VERSION;
  } catch {
    return true;
  }
}

/** `value` as kept under a key: with its format. */
export function stored(value: object): string {
  return JSON.stringify({ v: STORED_VERSION, ...value });
}
