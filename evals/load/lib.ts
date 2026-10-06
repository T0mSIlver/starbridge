import { homedir } from "node:os";

export const LOAD_DIR = process.env.LOAD_DIR ?? `${homedir()}/work/starbridge/.scratch/load`;

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
