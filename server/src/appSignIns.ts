/** How long the page that passed an app's sign-in on may ask whether it finished (#943). */
export const APP_SIGN_IN_MS = 10 * 60_000;
/** Sign-ins kept at once; past it the oldest go, so a flood costs memory only up to here. */
const MAX = 10_000;

/**
 * The account each app sign-in reached, by its PKCE challenge, in memory only (#943). The page
 * in the browser that carried the sign-in knows the challenge and asks with its own session;
 * nothing here outlives a restart or 10 minutes.
 */
/** Sets `key` in a map kept in insertion order, dropping the oldest entry past MAX. */
function keep<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export class AppSignIns {
  private byChallenge = new Map<string, { account: string; at: number }>();
  /**
   * The challenge each code came back with, for codes that passed through this server, and
   * whether the browser it came back to started that sign-in.
   */
  private challengeByCode = new Map<string, { challenge: string; bound: boolean; at: number }>();
  /** Challenges an app sign-in started with, which start once. */
  private started = new Map<string, { at: number }>();

  /**
   * Whether this challenge starts an app sign-in for the first time in 10 minutes. Only that
   * browser gets the cookie that binds the sign-in's return to it, so someone who reads the
   * challenge from its address cannot start one of their own with it.
   */
  start(challenge: string, now = Date.now()): boolean {
    const s = this.started.get(challenge);
    if (s !== undefined && now - s.at < APP_SIGN_IN_MS) return false;
    keep(this.started, challenge, { at: now });
    return true;
  }

  /**
   * Keeps the challenge a code came back with, so the trade can check the verifier itself rather
   * than rely on the provider binding the code to it. `bound`: the browser started the sign-in.
   */
  passed(code: string, challenge: string, bound: boolean, now = Date.now()): void {
    keep(this.challengeByCode, code, { challenge, bound, at: now });
  }

  /**
   * What a code came back with, once: undefined for a code that never passed through this
   * server (a verified App Link caught it) or that came back over 10 minutes ago.
   */
  take(code: string, now = Date.now()): { challenge: string; bound: boolean } | undefined {
    const s = this.challengeByCode.get(code);
    this.challengeByCode.delete(code);
    return s !== undefined && now - s.at < APP_SIGN_IN_MS ? s : undefined;
  }

  add(challenge: string, account: string, now = Date.now()): void {
    keep(this.byChallenge, challenge, { account, at: now });
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
      for (const [k, s] of map) {
        if (now - s.at < APP_SIGN_IN_MS) break;
        map.delete(k);
      }
  }
}
