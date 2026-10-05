// iOS gives Web Push only to web apps opened from the Home Screen (iOS 16.4 and later), and asks
// for permission only from a tap inside one. A Safari tab offers that step instead of a button.

export type Browser = {
  userAgent: string;
  maxTouchPoints: number;
  /** Opened from the Home Screen or as an installed app. */
  installed: boolean;
};

export function thisBrowser(): Browser {
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    installed:
      (navigator as { standalone?: boolean }).standalone === true ||
      matchMedia("(display-mode: standalone)").matches,
  };
}

/** True in an iOS browser tab on 16.4 or later: push works once the page is on the Home Screen. */
export function needsHomeScreen(b: Browser): boolean {
  if (b.installed) return false;
  const ua = b.userAgent;
  // iPadOS asks for desktop pages and says it is a Mac; only the touch screen gives it away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && b.maxTouchPoints > 1);
  if (!ios) return false;
  const v = ua.match(/OS (\d+)_(\d+)/) ?? ua.match(/Version\/(\d+)\.(\d+)/);
  if (!v) return true;
  const [major, minor] = [Number(v[1]), Number(v[2])];
  return major > 16 || (major === 16 && minor >= 4);
}
