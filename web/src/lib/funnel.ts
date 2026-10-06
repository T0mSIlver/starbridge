// The signed-in end of the launch funnel (#559): a new account's first sign-in, first machine and
// first answer, each sent once, from the browser that created the account. The app loads no
// tracker; these three events are all it sends to Umami (SPEC.md, "The hosted instance").
import { analyticsOn, WEBSITE_ID } from "./analytics";
import { readStored, stored } from "./stored";

export const FUNNEL_KEY = "starbridge.funnel";

/** Past this the steps left are dropped: Umami's daily salt has long split the visit anyway. */
const KEEP_MS = 2 * 24 * 3600 * 1000;

export type Step = "first-machine" | "first-answer";

type Left = { since: number; steps: Step[] };

function read(): Left | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(FUNNEL_KEY);
  } catch {}
  const v = readStored(FUNNEL_KEY, raw) as Partial<Left> | null;
  if (!v || typeof v.since !== "number" || !Array.isArray(v.steps)) return null;
  return { since: v.since, steps: v.steps };
}

function write(left: Left | null) {
  try {
    if (left?.steps.length) localStorage.setItem(FUNNEL_KEY, stored(left));
    else localStorage.removeItem(FUNNEL_KEY);
  } catch {}
}

function optedOut(): boolean {
  try {
    if (localStorage.getItem("umami.disabled")) return true;
  } catch {}
  return navigator.doNotTrack === "1";
}

/**
 * Posts one event as Umami's tracker would, with the page and its title replaced by `/` and
 * "Starbridge" so nothing of the app's screens leaves the browser. Umami joins it to the
 * landing page's visit by the same address, browser and day.
 */
export function send(name: string) {
  if (!analyticsOn() || optedOut()) return;
  const payload = {
    website: WEBSITE_ID,
    hostname: location.hostname,
    language: navigator.language,
    screen: `${screen.width}x${screen.height}`,
    url: "/",
    title: "Starbridge",
    name,
  };
  fetch("/stats/api/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "event", payload }),
    keepalive: true,
  }).catch(() => {});
}

/** A new account's first screen: counts the sign-in once, and waits for the next two steps. */
export function firstSignIn(now = Date.now()) {
  if (!analyticsOn()) return;
  const left = read();
  if (left && now - left.since < KEEP_MS) return;
  write({ since: now, steps: ["first-machine", "first-answer"] });
  send("first-sign-in");
}

/** Sends each step `reached` of those this browser waits for, once. */
export function reach(reached: (step: Step) => boolean, now = Date.now()) {
  const left = read();
  if (!left) return;
  if (now - left.since >= KEEP_MS) return write(null);
  const done = left.steps.filter(reached);
  if (!done.length) return;
  for (const step of done) send(step);
  write({ since: left.since, steps: left.steps.filter((s) => !done.includes(s)) });
}
