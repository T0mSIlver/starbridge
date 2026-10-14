/** How long the page that passed an app's sign-in on may ask whether it finished (#943). */
export const APP_SIGN_IN_MS = 10 * 60_000;
/** Sign-ins kept at once; past it the oldest go, so a flood costs memory only up to here. */
const MAX = 10_000;

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
  private challengeByCode = new Map<string, { challenge: string; bound: boolean; at: number }>();
  /**
   * Challenges an app sign-in started with, which start once (#1721), each with the random token
   * its browser got as a cookie.
   */
  private started = new Map<string, { token: string; at: number }>();

  /**
   * Whether this challenge starts an app sign-in for the first time in 10 minutes: only that
   * browser gets the cookie that binds the sign-in's return to it, so someone who reads the
   * challenge from its address cannot start one of their own with it. False too when the map is
   * full, rather than forget a live start.
   */
  start(challenge: string, token: string, now = Date.now()): boolean {
    const s = this.started.get(challenge);
    if (s !== undefined && now - s.at < APP_SIGN_IN_MS) return false;
    this.started.delete(challenge);
    if (this.started.size >= MAX) return false;
    this.started.set(challenge, { token, at: now });
    return true;
  }

  /** The token the browser that started this challenge's sign-in got, while it is fresh. */
  startToken(challenge: string, now = Date.now()): string | undefined {
    const s = this.started.get(challenge);
    return s !== undefined && now - s.at < APP_SIGN_IN_MS ? s.token : undefined;
  }

  /**
   * Keeps the challenge a code came back with from GitHub, so the trade can check the verifier
   * itself rather than rely on GitHub binding the code to it. The first challenge a code came
   * with stays: false when it came with another, or when the map is full, since dropping a
   * live entry would let a flood of made-up codes free a caught one.
   */
  passed(code: string, challenge: string, bound: boolean, now = Date.now()): boolean {
    const s = this.challengeOf(code, now);
    if (s !== undefined) return s.challenge === challenge;
    this.challengeByCode.delete(code);
    if (this.challengeByCode.size >= MAX) return false;
    this.challengeByCode.set(code, { challenge, bound, at: now });
    return true;
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
      for (const [k, s] of map) {
        if (now - s.at < APP_SIGN_IN_MS) break;
        map.delete(k);
      }
  }
}
