import { isIPv6 } from "node:net";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./env";
import { clientIp } from "./http";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** At most this many calls per this many milliseconds. */
type RateWindow = readonly [calls: number, ms: number];

/**
 * Everything that bounds what one account, or one address, can make the server store or do.
 * PROTOCOL.md lists them; keep the two in step.
 */
export const DEFAULT_LIMITS = {
  /** Item posts per account: a machine running many agents posts a few hundred decisions a day. */
  items: [120, MINUTE] as RateWindow,
  /** Stored decisions per account, open or answered. */
  decisions: 10_000,
  /** Sealed boxes stored per account, in bytes. */
  storedBytes: 128 * 1024 * 1024,
  /** Stored bytes only answers may use, so a full account can still answer. */
  answerReserve: 8 * 1024 * 1024,
  /**
   * Sealed boxes of one decision or quota snapshot, in bytes. Each box carries the decision's
   * images, so this is what lets a phone screenshot reach three or four devices at full size.
   */
  itemBytes: 2 * 1024 * 1024,
  /** Sealed box of one answer, in bytes: an answer's text is at most 4000 characters. */
  answerBytes: 32 * 1024,
  /** Stored permission prompts per account, open or settled; each lives answeredRetention. */
  permissions: 10_000,
  /** Bytes charged per stored row (an item, and each of its boxes) on top of its boxes. */
  rowBytes: 512,
  /** Stored runs per account; each lives runRetention after its last update. */
  runs: 500,
  /** Sealed boxes of one run update, in bytes. */
  runBytes: 32 * 1024,
  /** Runs are dropped this long after their last update. */
  runRetention: DAY,
  /** Answered decisions and their answers are dropped this long after the answer. */
  answeredRetention: 7 * DAY,
  /** Unanswered decisions, and quota snapshots no machine has replaced, are dropped after this. */
  staleRetention: 30 * DAY,

  /** Directory appends per account. */
  directoryAppends: [30, HOUR] as RateWindow,
  /** Directory entries per account past which devices add no members; revocations still pass. */
  directoryEntries: 200,
  /** Devices the recovery key may still add past directoryEntries. */
  recoveryAdds: 20,
  /**
   * Recovery keys devices may still propose past directoryEntries, so a chain a stolen device
   * filled still lets the owner replace the key; confirmations never outnumber proposals.
   */
  recoveryProposals: 20,
  /** One directory entry's JSON, in bytes. */
  entryBytes: 8 * 1024,

  /** Sessions per account; signing in past this ends the oldest, unpaired ones first. */
  sessions: 50,
  /** GitHub sign-ins finished per address. */
  githubCallbacks: [20, MINUTE] as RateWindow,
  /** Owner-token sign-ins per address, so the token cannot be guessed fast. */
  ownerSignIns: [10, MINUTE] as RateWindow,
  /** Sign-in challenges per account, which a device signs to bind a new session. */
  challenges: [20, MINUTE] as RateWindow,

  /** Pairing requests posted per address. */
  pairingPosts: [10, MINUTE] as RateWindow,
  /** Pairing requests read per account, by the device that shows the QR code. */
  pairingReads: [30, MINUTE] as RateWindow,
  /** Pairing results read per address, by the member that posted the request. */
  pairingResults: [60, MINUTE] as RateWindow,

  /**
   * Pairings stored on the whole server, about 4 KB each: the disk bound. Filling it takes a
   * thousand addresses at pairingsPerClient.
   */
  pendingPairings: 20_000,
  /**
   * Unapproved pairings per address, an IPv6 client counting as its /48. Approved ones do not
   * count, so an office behind one NAT pairs as many members as it likes, 20 waiting at a time.
   */
  pairingsPerClient: 20,

  /** Push subscription writes per account. */
  pushSubscribes: [30, MINUTE] as RateWindow,
  /** Pushes relayed for other servers per address, on a server in relay mode. */
  relayPosts: [120, MINUTE] as RateWindow,

  /** Asks for fresh quota snapshots per account; each makes every machine run CodexBar. */
  quotaAsks: [6, MINUTE] as RateWindow,

  /** Open answer long-polls per machine: one per waiting session plus the mod. */
  answerWaits: 32,
  /** Open result long-polls per pairing, and open request long-polls per rendezvous id. */
  pairingWaits: 4,

  /** Join requests per account. */
  joins: [10, MINUTE] as RateWindow,
  /** Open long-polls on the account's join list: one per open page or app. */
  joinListWaits: 16,
  /** Open long-polls per join request: its joining device and the comparing device. */
  joinWaits: 4,
};

export type Limits = typeof DEFAULT_LIMITS;

/** The caller's address as a rate-limit key; an IPv6 client counts as its /64, or `prefix`. */
export function ipKey(c: Context<Env>, prefix: 48 | 64 = 64): string {
  const ip = clientIp(c);
  if (!isIPv6(ip) || ip.includes(".")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, prefix / 16)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/${prefix}`;
}

/** Counts one call under `key`, or answers 429 `rate-limited` with Retry-After. */
export function rateLimit(c: Context<Env>, key: string, [calls, ms]: RateWindow) {
  const wait = c.var.limiter.retryAfter(key, calls, ms);
  if (wait === 0) return;
  throw new HTTPException(429, {
    res: Response.json(
      { error: "rate-limited", detail: `at most ${calls} per ${ms / 1000} s; retry later` },
      { status: 429, headers: { "retry-after": String(wait) } },
    ),
  });
}
