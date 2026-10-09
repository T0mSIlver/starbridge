// The routes of PROTOCOL.md a device calls. Same origin, so the session cookie rides along; the
// page and the service worker both use this.
import {
  type AccountSettings,
  CLIENT_HEADER,
  clientHeader,
  type PairingMessage,
  type SealedItem,
  type SignedEnvelope,
} from "@starbridge/protocol";
import pkg from "../../package.json";
import { desktop } from "./desktop";
import type { JoinView } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * What a failed pairing says on Add a device: a sentence in the app's words, Android's where it
 * has them, rather than the API's code (#289).
 */
export function pairingError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  if (e.status === 404) return "No pairing with this code, or it expired.";
  switch (e.code) {
    case "already-approved":
      return "This code was already approved.";
    case "already-paired":
      return "That device is already paired.";
    case "revoked":
      return "This browser was removed from the account.";
    case "unauthenticated":
      return "Sign-in expired. Sign in again.";
    case "machine-cap":
      return "This account already has its maximum number of machines; phones and browsers don't count. Revoke one first.";
    case "rate-limited":
      return "Too many tries. Wait a minute.";
  }
  const said = e.detail ?? e.code;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? "" : "."}`;
}

/** Sent on every call, the service worker's own fetches included; the desktop app's page says so. */
export const CLIENT = {
  [CLIENT_HEADER]: desktop
    ? clientHeader("desktop", desktop.version)
    : clientHeader("web", pkg.version),
};

/**
 * Set once the server answers 426 `client-too-old`: it no longer serves this page's release, and
 * the page shows only a reload (`Gate`).
 */
export const outdated = {
  is: false,
  listeners: new Set<() => void>(),
  subscribe(fn: () => void) {
    outdated.listeners.add(fn);
    return () => outdated.listeners.delete(fn);
  },
};

/** Why a call never got an answer: the browser is offline, or the server is away. */
export class Unreachable extends Error {
  constructor(readonly offline: boolean) {
    super(offline ? "You're offline." : "Can't reach the Starbridge server.");
  }
}

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * One backoff for every call in this page (or the service worker) while the server does not
 * answer, so they wait together instead of each retrying twice a second (#332). The wait doubles
 * from 250 ms to 30 s, with jitter so open tabs spread out, and ends on any answer and on the
 * browser's online event. A deploy restarts the server in a few seconds (#150), so a call retries
 * quietly on this backoff for `retryForMs` before the caller hears of it (#250). Each call's first
 * try always goes out, since an answer, a push or a sign-in may be the one that finds the server
 * back; pollers skip their turn while `backingOff()` instead.
 *
 * A 429 with `Retry-After`, from Caddy's per-address limit (#582) or the server's, is a backoff
 * too, for at least that long (#645). The server is up and said when to come back, so `limited`
 * holds every call's first try as well until then, and the call is retried whatever its method,
 * since the request was refused before it did anything.
 */
export const backoff = { failures: 0, until: 0, limited: false, retryForMs: 20_000 };
const wakers = new Set<() => void>();

/** Whether calls are waiting for the server: a poller skips its turn meanwhile. */
export const backingOff = () => Date.now() < backoff.until;

function answered() {
  backoff.failures = 0;
  backoff.until = 0;
  backoff.limited = false;
  for (const wake of wakers) wake();
}

function unanswered() {
  const now = Date.now();
  // Calls in flight together fail together: count them once.
  if (now < backoff.until) return;
  backoff.limited = false;
  backoff.failures++;
  const ceiling = Math.min(30_000, 250 * 2 ** (backoff.failures - 1));
  backoff.until = now + ceiling * (0.5 + Math.random() / 2);
}

function limited(ms: number) {
  backoff.limited = true;
  // Jitter spreads open tabs past the limit's window rather than all into its first moment.
  backoff.until = Math.max(backoff.until, Date.now() + ms * (1 + Math.random() / 4));
}

/** `Retry-After` in ms, from seconds or an HTTP date; null when absent or unreadable. */
export function retryAfter(res: Response): number | null {
  const v = res.headers.get("retry-after")?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

globalThis.addEventListener?.("online", answered);

/** Resolves after `ms` or once the server answers another call; rejects when `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      clearTimeout(t);
      wakers.delete(done);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(t);
      wakers.delete(done);
      reject(signal?.reason);
    };
    const t = setTimeout(done, ms);
    wakers.add(done);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function call<T>(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const started = Date.now();
  let res: Response;
  for (let first = true; ; first = false) {
    // A retry waits until the backoff ends, which another call's failure may push back meanwhile.
    while (!first || backoff.limited) {
      const wait = Math.max(0, backoff.until - Date.now());
      if (Date.now() - started + wait > backoff.retryForMs)
        throw backoff.limited
          ? new ApiError(429, "rate-limited", "too many requests; retry later")
          : new Unreachable(offline());
      if (wait === 0) {
        // A 429's hold is over; a later outage's deadline must not read as a rate limit.
        backoff.limited = false;
        break;
      }
      await pause(wait, opts.signal);
    }
    try {
      res = await fetch(`/v1${path}`, {
        method,
        credentials: "same-origin",
        headers: {
          ...CLIENT,
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      unanswered();
      // fetch tells a refused connection from one cut after the request left by nothing, so
      // only a read, which is safe to repeat, retries on it.
      if (method !== "GET") throw new Unreachable(offline());
      continue;
    }
    const after = res.status === 429 ? retryAfter(res) : null;
    if (res.status !== 502 && res.status !== 503 && after === null) break;
    await res.body?.cancel();
    if (after === null) unanswered();
    else limited(after);
  }
  answered();
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.status === 426 && !outdated.is) {
    outdated.is = true;
    for (const fn of outdated.listeners) fn();
  }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, e.error ?? res.statusText, e.detail);
  }
  return json as T;
}

export interface Me {
  account: string;
  member: string | null;
  role: "device" | "machine";
}

export interface Stored {
  item: SealedItem;
  cursor: string;
  receivedAt: string;
  answeredAt?: string;
}

export const api = {
  me: () => call<Me>("GET", "/me"),
  signInMethods: async () => (await call<{ methods: string[] }>("GET", "/auth/methods")).methods,
  ownerSignIn: (token: string) =>
    call<{ session: string }>("POST", "/auth/owner", { body: { token } }),
  logout: () => call<void>("POST", "/auth/logout"),
  challenge: async () => (await call<{ nonce: string }>("GET", "/auth/challenge")).nonce,
  bind: (member: string, sig: string) =>
    call<{ member: string }>("POST", "/auth/bind", { body: { member, sig } }),

  directory: async () => (await call<{ entries: SignedEnvelope[] }>("GET", "/directory")).entries,
  append: (entry: SignedEnvelope) =>
    call<{ length: number; head: string }>("POST", "/directory", { body: { entry } }),

  pairing: (rendezvous: string) =>
    call<{ request: unknown }>("GET", `/pairings/${encodeURIComponent(rendezvous)}`),
  /** Holds until the new member posts under `rendezvous`; undefined when `wait` passes first. */
  awaitPairing: (rendezvous: string, wait: number, signal?: AbortSignal) =>
    call<{ request: unknown } | undefined>(
      "GET",
      `/pairings/${encodeURIComponent(rendezvous)}?wait=${wait}`,
      { signal },
    ),
  approve: (rendezvous: string, approval: PairingMessage) =>
    call<{ approved: true }>("POST", `/pairings/${encodeURIComponent(rendezvous)}/approve`, {
      body: { approval },
    }),
  requestPairing: (request: PairingMessage, claimHash: string) =>
    call<{ expiresInSeconds: number }>("POST", "/pairings", { body: { request, claimHash } }),
  /** Undefined while the pairing waits (204). */
  pairingResult: (rendezvous: string, claim: string, wait: number, signal?: AbortSignal) =>
    call<{ approval: unknown } | undefined>(
      "GET",
      `/pairings/${encodeURIComponent(rendezvous)}/result?wait=${wait}`,
      { headers: { "x-claim": claim }, signal },
    ),

  postJoin: (request: string, commitment: string) =>
    call<{ join: JoinView }>("POST", "/joins", { body: { request, commitment } }),
  /** Open join requests; with `wait`, holds until any changes past `after`. */
  joins: (after: string, wait: number, signal?: AbortSignal) =>
    call<{ joins: JoinView[]; cursor: string }>(
      "GET",
      `/joins?after=${encodeURIComponent(after)}&wait=${wait}`,
      { signal },
    ),
  join: (id: string, after: number, wait: number, signal?: AbortSignal) =>
    call<{ join: JoinView }>(
      "GET",
      `/joins/${encodeURIComponent(id)}?after=${after}&wait=${wait}`,
      { signal },
    ),
  claimJoin: (id: string, key: string, approver: string) =>
    call<{ join: JoinView }>("POST", `/joins/${encodeURIComponent(id)}/approver`, {
      body: { key, approver },
    }),
  revealJoin: (id: string, key: string) =>
    call<{ join: JoinView }>("POST", `/joins/${encodeURIComponent(id)}/reveal`, {
      body: { key },
    }),
  approveJoin: (id: string, approval: PairingMessage) =>
    call<{ approved: true }>("POST", `/joins/${encodeURIComponent(id)}/approve`, {
      body: { approval },
    }),
  cancelJoin: (id: string) => call<void>("DELETE", `/joins/${encodeURIComponent(id)}`),

  deleteItem: (id: string) => call<void>("DELETE", `/items/${encodeURIComponent(id)}`),
  items: (kind: string, after?: string, opts: { open?: boolean } = {}) =>
    call<{ items: Stored[]; cursor: string }>(
      "GET",
      `/items?kind=${kind}${after ? `&after=${encodeURIComponent(after)}` : ""}${opts.open ? "&open=1" : ""}`,
    ),
  item: (id: string) => call<Stored>("GET", `/items/${encodeURIComponent(id)}`),
  quota: async () => (await call<{ items: Stored[] }>("GET", "/quota")).items,
  /** Asks every machine for a fresh snapshot; holds up to `wait` seconds for them. */
  askQuota: (wait: number) =>
    call<{ askedAt: string; behind: number }>("POST", `/quota/ask?wait=${wait}`),
  /** Whether the owner sits at this page (#848): one bit. */
  presence: (present: boolean) => call<void>("PUT", "/presence", { body: { present } }),
  settings: () => call<AccountSettings>("GET", "/settings"),
  saveSettings: (settings: AccountSettings) =>
    call<AccountSettings>("PUT", "/settings", { body: settings }),
  post: (item: SealedItem) => call<{ cursor: string }>("POST", "/items", { body: item }),

  vapid: async () => (await call<{ publicKey: string }>("GET", "/push/vapid")).publicKey,
  subscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    call<{ id: string }>("POST", "/push/subscriptions", {
      body: { type: "webpush", endpoint, keys },
    }),
  unsubscribe: (id: string) =>
    call<void>("DELETE", `/push/subscriptions/${encodeURIComponent(id)}`),
};
