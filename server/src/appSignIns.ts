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

  sweep(now = Date.now()): void {
    for (const [k, s] of this.byChallenge) {
      if (now - s.at < APP_SIGN_IN_MS) break;
      this.byChallenge.delete(k);
    }
  }
}
