/**
 * The launch thresholds, from the planning repo's launch/watch.md unless marked "not in
 * watch.md". The watcher (watch.ts) alerts when one is crossed; "for N minutes" ones need every
 * reading over that span to cross it.
 */
export const THRESHOLDS = {
  /** The 15-minute load average: watch.md's "load over 1.6 for 15 minutes". */
  load15: 1.6,
  /** CPU steal, percent. */
  stealPercent: 20,
  /** Memory used on the box, MB, for memoryMinutes. */
  memoryUsedMB: 3000,
  memoryMinutes: 10,
  /** Free disk, bytes. */
  diskFreeBytes: 5 * 1024 ** 3,
  /** `GET /healthz` or `GET /` from outside, ms, for slowMinutes. */
  slowMs: 1000,
  slowMinutes: 10,
  /** Caddy's connections to the server (long-polls). */
  toServer: 3000,
  /** Database and WAL, bytes; and growth per hour. */
  dbBytes: 1024 ** 3,
  dbGrowthPerHour: 100 * 1024 ** 2,
  /** Per run: any stack trace, SQLITE_ error, full disk or full push queue. */
  stackTraces: 1,
  sqlite: 1,
  diskFull: 1,
  pushQueueFull: 1,
  /** Per run: a run of push failures (FCM or Web Push). */
  pushFailed: 10,
  /** Per run: GitHub sign-in errors in the server log. */
  githubSignIn: 5,
  /** Per run: Caddy's error log lines (502s, upstream failures). Not in watch.md. */
  caddyErrors: 5,
  /** Per run: 5xx answered by the server ("any repeated 500, 502 or 503"). */
  serverErrors: 3,
  /** Per run: 429s on GitHub sign-in or pairing posts: a NAT signing up together. */
  signInLimited: 20,
  /** Per run: 429s on any route. Not in watch.md, which says "a few" is normal. */
  limited: 300,
  /** Per run: 403 machine-cap ("several users hitting it"). */
  machineCap: 5,
  /** Per run: 409 too-many-items, account-full or directory-full, and 413s. Not in watch.md. */
  accountFull: 20,
  tooLarge: 20,
  /** Per run: 503 storage-full, the server-wide byte cap. */
  storageFull: 1,
  /** An address holding over this many connections to Caddy now. Tom's rule, 2026-10-07. */
  addressConnections: 200,
  /**
   * An address making this many /v1 requests a minute is at Caddy's cap of 3000, so Caddy is
   * refusing the rest; the server sees only those it lets through. Tom's rule, 2026-10-07.
   */
  addressRequests: 2900,
  /** An address the server refused this many times with 429 in the last 2 minutes. */
  addressLimited: 20,
  /** Sign-ups in the last hour. Not in watch.md: the launch week expects a few hundred. */
  signUpsPerHour: 200,
  /** One account's posts in the last hour, and bytes stored (its cap is 256 MB). Not in watch.md. */
  accountPostsPerHour: 3000,
  accountBytes: 200 * 1024 ** 2,
  /** Minutes before an alert that still holds wakes the watcher again. */
  remindMinutes: 60,
};
