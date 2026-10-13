// What the service worker (src/sw/sw.ts) shows when a push's own notification does not come
// (#1363). Safari drops a site's push subscriptions once three of its pushes, over the
// subscription's life, showed no notification within 30 s (WebKit's `maxSilentPushCount`), and
// pushes stop until the page next opens and subscribes again. Other browsers tolerate a few.

/**
 * How long a push may take to show its notification before the placeholder shows: under
 * Safari's 30 s, with room for a slow phone.
 */
export const SHOW_WITHIN_MS = 20_000;

/** Whether `endpoint` is Apple's Web Push service, Safari's on iOS and macOS. */
export function applePush(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "push.apple.com" || host.endsWith(".push.apple.com");
  } catch {
    return false;
  }
}

/**
 * How a push ended without showing its own notification: `failed` threw (a fetch, a check),
 * `late` is still opening at `SHOW_WITHIN_MS`, `empty` ended with nothing to show (answered
 * meanwhile, a notice that only closes one).
 */
export type Unshown = "failed" | "late" | "empty";

/** Whether a push has shown a notification yet, and the placeholder's tag if that is what. */
export type Shown = { shown: boolean; placeholder?: string };

/**
 * Opens one push with `open`, and shows `fallback`'s note when it showed nothing: at `within`
 * while it is still opening, which its own notification replaces when it comes, and once it
 * ended. `failed` gets what `open` threw first.
 */
export async function openPush(
  open: (seen: Shown) => Promise<void>,
  showFallback: (why: Unshown, seen: Shown) => Promise<void>,
  failed: (err: unknown) => Promise<void>,
  within = SHOW_WITHIN_MS,
): Promise<void> {
  const seen: Shown = { shown: false };
  const run = open(seen).then(
    () => undefined,
    (err: unknown) => ({ err }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => done("late"), within);
  });
  const first = await Promise.race([run, late]);
  clearTimeout(timer);
  if (first === "late" && !seen.shown) await showFallback("late", seen);
  const error = first === "late" ? await run : first;
  if (error) await failed(error.err);
  if (!seen.shown) await showFallback(error ? "failed" : "empty", seen);
}

export interface Fallback {
  title: string;
  options: NotificationOptions & { silent?: boolean };
}

/** The placeholders the iPhone app's pushes carry (server/src/apns.ts), by push kind. */
const ASKS: Record<string, string> = {
  decision: "A question needs you",
  waiting: "A question needs you",
  snooze: "A question needs you",
  permission: "A permission prompt needs you",
  join: "A device wants to join",
};

/** The tags a fallback shows under, so the page closes them once the owner opens it. */
export const FALLBACK_TAGS = ["open", "quiet"];

/**
 * What to show for a push that showed nothing, or undefined to show nothing. One that asks for
 * the owner and could not be opened shows the placeholder, which tapped opens the inbox: missing
 * it would lose a question. On Safari every other push still shows a quiet one, which costs a
 * notification but keeps the subscription.
 */
export function fallback(text: string, why: Unshown, apple: boolean): Fallback | undefined {
  let p: { kind?: string; id?: string; due?: boolean } = {};
  try {
    p = JSON.parse(text) ?? {};
  } catch {}
  // A snooze as it is posted only hides a question; at its time it asks again.
  const asks = p.kind && ASKS[p.kind] && !(p.kind === "snooze" && p.due === false);
  if (asks && why !== "empty")
    return {
      title: "Starbridge",
      options: {
        body: ASKS[p.kind as string],
        // A question's or a prompt's own tag, which its notification replaces once it opens.
        tag:
          p.kind === "decision" && p.id
            ? `d:${p.id}`
            : p.kind === "permission" && p.id
              ? `p:${p.id}`
              : "open",
        requireInteraction: true,
      },
    };
  if (!apple) return undefined;
  return {
    title: "Starbridge",
    options: { body: "Nothing new needs you.", tag: "quiet", silent: true },
  };
}

/**
 * Closes the notifications of questions that no longer need the owner, answered, settled or
 * snoozed, and once the page shows, the placeholders. Safari gets no push that only closes one,
 * so its notifications wait for this.
 */
export async function closeStale(
  reg: Pick<ServiceWorkerRegistration, "getNotifications"> | undefined,
  items: { decision: { id: string }; answeredAt?: string; settled?: unknown }[],
  snoozes: Record<string, { until: string }> = {},
  visible: boolean,
  now = Date.now(),
): Promise<void> {
  const done = new Set(
    items
      .filter(
        (i) => i.answeredAt || i.settled || Date.parse(snoozes[i.decision.id]?.until ?? "") > now,
      )
      .map((i) => `d:${i.decision.id}`),
  );
  for (const n of (await reg?.getNotifications().catch(() => [])) ?? [])
    if (done.has(n.tag) || (visible && FALLBACK_TAGS.includes(n.tag))) n.close();
}
