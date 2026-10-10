/**
 * What the page and the app say to each other. The page sends its state; the app sends back what
 * the owner did in a notification. Everything is plain data, checked on arrival: the page comes
 * from a server, so the app trusts its words as far as showing them, and no further.
 */

/** One item that needs the owner, as its notification shows it. */
export interface Entry {
  /** The item's id; a question's options answer it. */
  id: string;
  title: string;
  body: string;
  /** A question's options, one button each; empty for a permission prompt or a link. */
  options: string[];
  /** Whether a typed answer is taken. */
  reply: boolean;
  /** Whether its agent waits; turning true notifies again, as on the phone. */
  waiting: boolean;
}

/** The page's state: the Needs-you count and the items to notify. */
export interface PageState {
  count: number;
  entries: Entry[];
  /** How many of `count` an agent waits on, for the widget (#1031); kept with notifications off. */
  waiting: number;
  /** Whether the page is signed in with its inbox loaded, signed out, or still loading. */
  account: Account;
}

export type Account = "ready" | "signedOut" | "loading";
const ACCOUNTS: Account[] = ["ready", "signedOut", "loading"];

/** A notification's answer, which the page sends as if typed or tapped there. */
export type Answer = { id: string; choice: string } | { id: string; text: string };

/** The page's word on an answer: sent, or why not. */
export interface Answered {
  id: string;
  error?: string;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_ENTRIES = 200;

export function parseState(x: unknown): PageState | null {
  if (!isObject(x) || !Array.isArray(x.entries) || x.entries.length > MAX_ENTRIES) return null;
  const { count } = x;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 99_999)
    return null;
  const entries: Entry[] = [];
  for (const e of x.entries) {
    const entry = parseEntry(e);
    if (!entry) return null;
    entries.push(entry);
  }
  // Pages before #1031 send neither: their entries say who waits, and a count means signed in.
  const waiting = x.waiting ?? entries.filter((e) => e.waiting).length;
  if (typeof waiting !== "number" || !Number.isInteger(waiting) || waiting < 0 || waiting > count)
    return null;
  const account = x.account ?? "ready";
  if (!ACCOUNTS.includes(account as Account)) return null;
  return { count, entries, waiting, account: account as Account };
}

function parseEntry(e: unknown): Entry | null {
  if (!isObject(e) || typeof e.id !== "string" || !ID.test(e.id)) return null;
  if (typeof e.title !== "string" || typeof e.body !== "string") return null;
  if (typeof e.reply !== "boolean" || typeof e.waiting !== "boolean") return null;
  if (!Array.isArray(e.options) || e.options.length > 4) return null;
  if (!e.options.every((o) => typeof o === "string" && o.length > 0 && o.length <= 200))
    return null;
  return {
    id: e.id,
    title: clip(e.title, 300),
    body: clip(e.body, 1000),
    options: e.options as string[],
    reply: e.reply,
    waiting: e.waiting,
  };
}

export function parseAnswered(x: unknown): Answered | null {
  if (!isObject(x) || typeof x.id !== "string" || !ID.test(x.id)) return null;
  if (x.error === undefined) return { id: x.id };
  return typeof x.error === "string" ? { id: x.id, error: clip(x.error, 300) } : null;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
