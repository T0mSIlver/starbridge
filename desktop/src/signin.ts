import { createHash, randomBytes } from "node:crypto";

/**
 * Sign-in through the owner's browser, as the Android app does (PROTOCOL.md, "App sign-in"): the
 * browser is already signed in to GitHub and holds its passkeys, which the app's window cannot
 * use. The app keeps a PKCE verifier and sends only its challenge; GitHub's code comes back on a
 * `starbridge://auth` link, and only the verifier trades it for a session.
 */
export interface SignIn {
  verifier: string;
  challenge: string;
  /** When it was started; a link after SIGN_IN_MS is ignored. */
  at: number;
}

export const SIGN_IN_MS = 10 * 60_000;

export function newSignIn(now = Date.now()): SignIn {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, at: now };
}

/**
 * The sign-in the window is about to start on the server for the page: its start path, GitHub's
 * or Apple's (#1411), else null.
 */
export function startsSignIn(url: string, origin: string): string | null {
  try {
    const u = new URL(url);
    const ours = ["/v1/auth/github", "/v1/auth/apple"].includes(u.pathname);
    return u.origin === origin && ours && !u.searchParams.has("app") ? u.pathname : null;
  } catch {
    return null;
  }
}

/** Where the browser goes to sign in for the app, from the start path the page took. */
export function browserSignIn(origin: string, s: SignIn, path = "/v1/auth/github"): string {
  return `${origin}${path}?app=1&challenge=${s.challenge}`;
}

/**
 * The answer in a `starbridge://auth` link, if it is for the sign-in this app started:
 * its state must be our challenge, and recent.
 */
export function signInReturn(
  link: string,
  s: SignIn | null,
  now = Date.now(),
): { code: string } | { error: string } | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "starbridge:" || url.hostname !== "auth" || !s) return null;
  if (url.searchParams.get("state") !== s.challenge || now - s.at > SIGN_IN_MS) return null;
  const word = /^[A-Za-z0-9_-]{1,100}$/;
  const code = url.searchParams.get("code") ?? "";
  const error = url.searchParams.get("error") ?? "";
  // Apple's codes are longer, with dots.
  if (/^[A-Za-z0-9._-]{1,1024}$/.test(code)) return { code };
  if (word.test(error)) return { error };
  return null;
}
