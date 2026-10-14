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
  /** The challenge each GitHub code came back with, for codes that passed through this server. */
  private challengeByCode = new Map<string, { challenge: string; at: number }>();

  /**
   * Keeps the challenge a code came back with from GitHub, so the trade can check the verifier
   * itself rather than rely on GitHub binding the code to it.
   */
  passed(code: string, challenge: string, now = Date.now()): void {
    this.challengeByCode.delete(code);
    this.challengeByCode.set(code, { challenge, at: now });
    if (this.challengeByCode.size > MAX) {
      const oldest = this.challengeByCode.keys().next().value;
      if (oldest !== undefined) this.challengeByCode.delete(oldest);
    }
  }

  /**
   * The challenge a code came back with, once: undefined for a code that never passed through
   * this server (a verified App Link caught it) or that came back over 10 minutes ago.
   */
  takeChallenge(code: string, now = Date.now()): string | undefined {
    const s = this.challengeByCode.get(code);
    this.challengeByCode.delete(code);
    return s !== undefined && now - s.at < APP_SIGN_IN_MS ? s.challenge : undefined;
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
    for (const map of [this.byChallenge, this.challengeByCode])
      for (const [k, s] of map) {
        if (now - s.at < APP_SIGN_IN_MS) break;
        map.delete(k);
      }
  }
}
