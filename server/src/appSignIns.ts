import { safeEqual } from "./auth";
/** How long the page that passed an app's sign-in on may ask whether it finished (#943). */
export const APP_SIGN_IN_MS = 10 * 60_000;
/** Sign-ins kept at once; past it the oldest go, so a flood costs memory only up to here. */
const MAX = 10_000;
/**
 * Starts or codes one address keeps at once (an IPv4 address, or an IPv6 /48): a person signs
 * in a few times in 10 minutes, and a flood from one address stops at its own share.
 */
export const PER_ADDRESS = 50;
/**
 * Entries of an address that keeps this many or fewer are never dropped to make room: a person's
 * sign-in in progress stays, whatever a flood from elsewhere does, so a code they passed keeps
 * the challenge the trade checks it against.
 */
const KEPT_ALWAYS = 5;

/**
 * Entries each charged to the address that made them (security audit 2026-10-20): one address
 * keeps at most `PER_ADDRESS`, and a full map makes room by dropping the oldest entry of the
 * address that keeps the most, when that is more than the asking address keeps and more than
 * `KEPT_ALWAYS`. So a flood from many addresses drops its own entries, never a person's.
 * Insertion order is age order, which `sweep` relies on.
 */
class Charged<V extends { at: number }> implements Iterable<[string, V]> {
  private items = new Map<string, { value: V; address: string }>();
  private byAddress = new Map<string, Set<string>>();

  constructor(private readonly max = MAX) {}

  get(key: string): V | undefined {
    return this.items.get(key)?.value;
  }

  get size(): number {
    return this.items.size;
  }

  delete(key: string): void {
    const e = this.items.get(key);
    if (e === undefined) return;
    this.items.delete(key);
    const keys = this.byAddress.get(e.address);
    keys?.delete(key);
    if (keys?.size === 0) this.byAddress.delete(e.address);
  }

  /** Keeps `value`, or refuses: the address keeps its share, or the map is full of no one else's more. */
  set(key: string, value: V, address: string): boolean {
    this.delete(key);
    const mine = this.byAddress.get(address)?.size ?? 0;
    if (mine >= PER_ADDRESS) return false;
    if (this.items.size >= this.max) {
      let most: Set<string> | undefined;
      for (const keys of this.byAddress.values()) if (!most || keys.size > most.size) most = keys;
      if (!most || most.size <= Math.max(mine, KEPT_ALWAYS)) return false;
      const oldest = most.values().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    this.items.set(key, { value, address });
    let keys = this.byAddress.get(address);
    if (!keys) {
      keys = new Set();
      this.byAddress.set(address, keys);
    }
    keys.add(key);
    return true;
  }

  *[Symbol.iterator](): Iterator<[string, V]> {
    for (const [k, e] of this.items) yield [k, e.value];
  }
}

/**
 * The account each app sign-in reached, by its PKCE challenge, in memory only (#943). The page
 * in the browser that carried the sign-in knows the challenge and asks with its own session;
 * nothing here outlives a restart or 10 minutes.
 */
export class AppSignIns {
  private byChallenge = new Map<string, { account: string; at: number }>();
  /**
   * The challenge each code came back with, for codes that passed through this server, and
   * whether the browser it came back to started that sign-in (#1721).
   */
  private challengeByCode = new Charged<{ challenge: string; bound: boolean; at: number }>();
  /**
   * Challenges an app sign-in started with, which start once (#1721), each with the random token
   * its browser got as a cookie.
   */
  private started = new Charged<{ token: string; at: number }>();

  /**
   * Whether this challenge starts an app sign-in for the first time in 10 minutes: only that
   * browser gets the cookie that binds the sign-in's return to it, so someone who reads the
   * challenge from its address cannot start one of their own with it. False too when `address`
   * keeps its share, or the map is full and no other address keeps more.
   */
  start(challenge: string, token: string, address: string, now = Date.now()): boolean {
    const s = this.started.get(challenge);
    if (s !== undefined && now - s.at < APP_SIGN_IN_MS) return false;
    return this.started.set(challenge, { token, at: now }, address);
  }

  /**
   * Whether `cookie` is the token the browser that started this challenge's sign-in got, once:
   * the first code that comes back with it takes it, so a link to the callback with another
   * code, opened in that browser later, binds nothing. A wrong cookie takes nothing.
   */
  takeStartToken(challenge: string, cookie: string, now = Date.now()): boolean {
    const s = this.started.get(challenge);
    if (s === undefined || now - s.at >= APP_SIGN_IN_MS || !s.token) return false;
    if (!safeEqual(s.token, cookie)) return false;
    s.token = "";
    return true;
  }

  /**
   * Keeps the challenge a code came back with from GitHub, so the trade can check the verifier
   * itself rather than rely on GitHub binding the code to it. The first challenge a code came
   * with stays: false when it came with another, or when `address` keeps its share or the map
   * is full of no other address's more, since dropping a live entry of anyone's would let a flood
   * of made-up codes free a caught one.
   */
  passed(
    code: string,
    challenge: string,
    bound: boolean,
    address: string,
    now = Date.now(),
  ): boolean {
    const s = this.challengeOf(code, now);
    if (s !== undefined) return s.challenge === challenge;
    return this.challengeByCode.set(code, { challenge, bound, at: now }, address);
  }

  /**
   * The challenge a code came back with, and whether it came back bound: undefined for a code that never passed through this
   * server (a verified App Link caught it) or that came back over 10 minutes ago.
   */
  challengeOf(code: string, now = Date.now()): { challenge: string; bound: boolean } | undefined {
    const s = this.challengeByCode.get(code);
    return s !== undefined && now - s.at < APP_SIGN_IN_MS ? s : undefined;
  }

  /** Forgets a code once traded: GitHub's work once. */
  traded(code: string): void {
    this.challengeByCode.delete(code);
  }

  add(challenge: string, account: string, now = Date.now()): void {
    this.byChallenge.delete(challenge);
    this.byChallenge.set(challenge, { account, at: now });
    if (this.byChallenge.size > MAX) {
      const oldest = this.byChallenge.keys().next().value;
      if (oldest !== undefined) this.byChallenge.delete(oldest);
    }
  }

  /** Whether the app behind this challenge signed in to this account in the last 10 minutes. */
  reached(challenge: string, account: string, now = Date.now()): boolean {
    const s = this.byChallenge.get(challenge);
    return s !== undefined && s.account === account && now - s.at < APP_SIGN_IN_MS;
  }

  /** Forgets a deleted account's sign-ins (#1104). */
  forget(account: string): void {
    for (const [k, s] of this.byChallenge) if (s.account === account) this.byChallenge.delete(k);
  }

  sweep(now = Date.now()): void {
    for (const map of [this.byChallenge, this.challengeByCode, this.started])
      for (const [k, s] of [...map]) {
        if (now - s.at < APP_SIGN_IN_MS) break;
        map.delete(k);
      }
  }
}
