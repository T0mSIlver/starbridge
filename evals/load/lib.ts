import { join } from "node:path";

export const LOAD_DIR = process.env.LOAD_DIR ?? join(import.meta.dir, "../../.scratch/load");

/** One account made by setup.ts: a phone, a machine and a web page, by their bearer tokens. */
export interface User {
  n: number;
  account: string;
  phone: string;
  machine: string;
  web: string;
  /** Directory length after setup. */
  directory: number;
}

/**
 * Latencies in log buckets 5% wide from 1 ms, so workers' counts merge by adding. Bucket i holds
 * values up to 1.05^i ms.
 */
export class Hist {
  counts: number[] = [];
  n = 0;

  add(ms: number) {
    const i = ms <= 1 ? 0 : Math.ceil(Math.log(ms) / Math.log(1.05));
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    this.n++;
  }

  merge(o: { counts: (number | null)[]; n: number }) {
    o.counts.forEach((c, i) => {
      if (c) this.counts[i] = (this.counts[i] ?? 0) + c;
    });
    this.n += o.n;
  }

  /** The q quantile in ms, as its bucket's upper bound. */
  q(q: number): number {
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i] ?? 0;
      if (seen >= q * this.n) return 1.05 ** i;
    }
    return 0;
  }
}

/** Base64url bytes of a sealed box about `size` long; the server never opens boxes. */
export function box(size: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(Math.ceil((size * 3) / 4)))).toString(
    "base64url",
  );
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Exponential delay with this mean, for Poisson arrivals. */
export function expMs(meanMs: number): number {
  return -Math.log(1 - Math.random()) * meanMs;
}

/** One stage of load.ts's `--json` result. Times in ms, memory in MB, CPU in % of a core. */
export interface StageResult {
  users: number;
  rps: number;
  p50: number;
  p99: number;
  deliveryP50: number;
  deliveryP99: number;
  /** Failed requests (status 400 and up, or no response) per request. */
  errorRate: number;
  /** Each container's peak memory, page cache left out. */
  peakMB: Record<string, number>;
  cpuPct: Record<string, number>;
  p99ByOp: Record<string, number>;
}

/** load.ts's `--json` result, which compare.ts reads. */
export interface LoadResult {
  at: string;
  stages: StageResult[];
  /** The drain's counts: answers lost or received twice, decisions no page saw. */
  final: Record<string, number>;
  /** Set when a stage broke: the server died, or p99 passed 1 s. */
  broke?: string;
  /** Each container's memory every 5 minutes, `t` in seconds from the start. */
  memory: { t: number; mb: Record<string, number> }[];
}

/** The fleet gives up on an answer or a decision after this long: lost, or unseen. */
export const GIVE_UP_MS = 600_000;

/**
 * The fleet's bookkeeping, so a run of weeks holds steady memory: an answer no machine got within
 * GIVE_UP_MS is lost (if the server took it), a decision no page saw is unseen, and an answer
 * that arrived is kept an hour more, to catch a double. Drops what it counted.
 */
export function settle(
  s: {
    /** Answer id -> when it was posted. */
    answers: Map<string, number>;
    /** Answer id -> how many times a machine got it. */
    got: Map<string, number>;
    /** Answers the server took. */
    acked: Set<string>;
    /** Decision id -> whether a page saw it. */
    decisions: Map<string, boolean>;
    decidedAt: Map<string, number>;
  },
  now: number,
): { lost: number; unseen: number } {
  let lost = 0;
  let unseen = 0;
  for (const [a, at] of s.answers) {
    if (s.got.has(a)) {
      if (now - at < 3_600_000) continue;
    } else if (now - at < GIVE_UP_MS) continue;
    else if (s.acked.has(a)) lost++;
    s.answers.delete(a);
    s.got.delete(a);
    s.acked.delete(a);
  }
  for (const [d, at] of s.decidedAt) {
    if (now - at < GIVE_UP_MS) continue;
    if (s.decisions.get(d) === false) unseen++;
    s.decisions.delete(d);
    s.decidedAt.delete(d);
  }
  return { lost, unseen };
}
