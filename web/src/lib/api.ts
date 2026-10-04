// The routes of PROTOCOL.md a device calls. Same origin, so the session cookie rides along; the
// page and the service worker both use this.
import type { PairingMessage, SealedItem, SignedEnvelope } from "@starbridge/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

async function call<T>(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
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

  items: (kind: string, after?: string, opts: { open?: boolean } = {}) =>
    call<{ items: Stored[]; cursor: string }>(
      "GET",
      `/items?kind=${kind}${after ? `&after=${encodeURIComponent(after)}` : ""}${opts.open ? "&open=1" : ""}`,
    ),
  item: (id: string) => call<Stored>("GET", `/items/${encodeURIComponent(id)}`),
  quota: async () => (await call<{ items: Stored[] }>("GET", "/quota")).items,
  post: (item: SealedItem) => call<{ cursor: string }>("POST", "/items", { body: item }),

  vapid: async () => (await call<{ publicKey: string }>("GET", "/push/vapid")).publicKey,
  subscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    call<{ id: string }>("POST", "/push/subscriptions", {
      body: { type: "webpush", endpoint, keys },
    }),
  unsubscribe: (id: string) =>
    call<void>("DELETE", `/push/subscriptions/${encodeURIComponent(id)}`),
};
