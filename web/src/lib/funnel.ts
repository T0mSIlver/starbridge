// The signed-in end of the launch funnel (#559): a new account's first sign-in, first machine and
// first answer, each sent once, from the browser that created the account. The app loads no
// tracker; these three events are all it sends to Umami (SPEC.md, "The hosted instance").
import { analyticsOn, WEBSITE_ID } from "./analytics";
import { readStored, stored } from "./stored";

export const FUNNEL_KEY = "starbridge.funnel";

/** Past this the steps left are dropped: Umami's daily salt has long split the visit anyway. */
const KEEP_MS = 2 * 24 * 3600 * 1000;

export type Step = "first-machine" | "first-answer";

type Left = { account: string; since: number; steps: Step[] };

function read(): Left | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(FUNNEL_KEY);
  } catch {}
  const v = readStored(FUNNEL_KEY, raw) as Partial<Left> | null;
  if (!v || typeof v.account !== "string" || typeof v.since !== "number" || !Array.isArray(v.steps))
    return null;
  return { account: v.account, since: v.since, steps: v.steps };
}

function write(left: Left | null) {
  try {
    if (left?.steps.length) localStorage.setItem(FUNNEL_KEY, stored(left));
    else localStorage.removeItem(FUNNEL_KEY);
  } catch {}
}

/** Umami's tracker's own opt-outs: its localStorage switch, and Do Not Track as browsers send it. */
function optedOut(): boolean {
  try {
    if (localStorage.getItem("umami.disabled")) return true;
  } catch {}
  const nav = navigator as Navigator & { msDoNotTrack?: string };
  const dnt =
    (globalThis as { doNotTrack?: string }).doNotTrack ?? nav.doNotTrack ?? nav.msDoNotTrack;
  return dnt === "1" || dnt === "yes";
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
export function firstSignIn(account: string, now = Date.now()) {
  if (!analyticsOn()) return;
  const left = read();
  if (left?.account === account && now - left.since < KEEP_MS) return;
  write({ account, since: now, steps: ["first-machine", "first-answer"] });
  send("first-sign-in");
}

/** Sends each step `reached` of those this browser waits for on `account`, once. */
export function reach(account: string, reached: (step: Step) => boolean, now = Date.now()) {
  const left = read();
  if (!left) return;
  // Another account signed in here, or the setup was left: the note is spent.
  if (left.account !== account || now - left.since >= KEEP_MS) return write(null);
  const done = left.steps.filter(reached);
  if (!done.length) return;
  for (const step of done) send(step);
  write({ ...left, steps: left.steps.filter((s) => !done.includes(s)) });
}
