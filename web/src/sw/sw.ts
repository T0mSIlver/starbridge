/// <reference lib="webworker" />
// The service worker: opens Web Push payloads (PROTOCOL.md, "Push") with this browser's device
// key, verifies them against the pinned directory, and shows the decision with its options as
// notification actions where the browser supports them. Built to public/sw.js by `bun run sw`.
import type { SealedItem } from "@starbridge/protocol";
import { CLIENT } from "../lib/api";
import {
  answer,
  deviceContext,
  noteSnoozes,
  openPushedDecision,
  openPushedPermission,
  openSettled,
  openSnooze,
  openWaiting,
  Withheld,
} from "../lib/device";
import { promptNote, questionNote } from "../lib/notes";
import { answerPlace } from "../lib/outcome";
import { applePush, fallback, openPush, type Shown, type Unshown } from "../lib/pushFallback";
import * as store from "../lib/store";
import type { InboxItem, PromptItem, Reply } from "../lib/types";

declare const self: ServiceWorkerGlobalScope;

/** What the server pushes: a new item with this device's box when it fits, or "answered". */
type Payload =
  | {
      v: 1;
      kind: "decision" | "quota" | "answer" | "permission" | "settled" | "waiting" | "snooze";
      id: string;
      from: string;
      re?: string;
      wakeAt?: string;
      /** A snooze's: false as it is posted, true at its time; absent from servers before #1290. */
      due?: boolean;
      box?: string;
    }
  | { v: 1; kind: "answered"; id: string }
  /** A browser or phone signed in to the account asks to join (PROTOCOL.md). */
  | { v: 1; kind: "join"; id: string };

const tag = (decisionId: string) => `d:${decisionId}`;
/** A permission prompt's notification; "answered" names the prompt, so both tags close. */
const promptTag = (permissionId: string) => `p:${permissionId}`;

/**
 * Decisions answered since this worker started, as "account/decision" (ids are unique per
 * account only): a push still opening must not show them.
 */
const answered = new Set<string>();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const text = e.data?.text() ?? "";
  // A push that asks for the owner shows something, on Safari every push (#1363).
  e.waitUntil(
    openPush(
      (seen) => onPush(text, seen),
      (why, seen) => showFallback(text, why, seen),
      async (err) => {
        // Held (#362): the notifications already up would still let the owner answer from them.
        // Run and quota alerts answer nothing, and would not show again, so they stay (#1281).
        if (err instanceof Withheld)
          for (const n of await self.registration.getNotifications())
            if (n.tag.startsWith("d:") || n.tag.startsWith("p:")) n.close();
        // Open pages log why.
        for (const c of await self.clients.matchAll({ type: "window" }))
          c.postMessage({ type: "starbridge:push-error", error: String(err) });
      },
    ),
  );
});

async function showFallback(text: string, why: Unshown, seen: Shown): Promise<void> {
  const sub = await self.registration.pushManager.getSubscription().catch(() => null);
  const note = fallback(text, why, !!sub && applePush(sub.endpoint));
  if (!note) return;
  await self.registration.showNotification(note.title, note.options);
  seen.shown = true;
  seen.placeholder = note.options.tag;
}

/** Shows a notification for the push `seen` tracks. */
async function show(seen: Shown, title: string, options: NotificationOptions): Promise<void> {
  await self.registration.showNotification(title, options);
  // The placeholder this push showed while late goes, unless this one replaced it. Safari keeps
  // one under 30 s old.
  if (seen.placeholder && seen.placeholder !== options.tag)
    for (const n of await self.registration.getNotifications({ tag: seen.placeholder })) n.close();
  seen.shown = true;
  seen.placeholder = undefined;
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(onClick(e.notification, e.action));
});

async function tellPages(kind: string): Promise<void> {
  for (const c of await self.clients.matchAll({ type: "window" }))
    c.postMessage({ type: "starbridge:push", kind });
}

async function onPush(text: string, seen: Shown): Promise<void> {
  let payload: Payload;
  try {
    payload = JSON.parse(text) as Payload;
  } catch {
    return;
  }
  await tellPages(payload.kind);
  const account = await store.get("current");
  if (payload.kind === "answered") {
    // Answered elsewhere: the question is settled, so its notification goes.
    answered.add(`${account}/${payload.id}`);
    for (const t of [tag(payload.id), promptTag(payload.id)])
      for (const n of await self.registration.getNotifications({ tag: t })) n.close();
    return;
  }
  // Quota snapshots skip Web Push; the page notifies about quota alerts (quotaSettings.ts).
  if (payload.kind === "answer" || payload.kind === "quota") return;

  // Every kind, a join request too, shows only while this browser is a device of the account
  // it is signed in to: the server may still hold its endpoint under an account it left (#1230).
  const ctx = account ? await deviceContext(account) : undefined;
  if (!ctx) return;
  if (payload.kind === "join") {
    // The server reads a join request only to a device of its account, so one pushed for an
    // account this browser left, while it is a device of another, shows nothing.
    const res = await fetch(`/v1/joins/${encodeURIComponent(payload.id)}`, { headers: CLIENT });
    if (!res.ok) return;
    await show(seen, "A device wants to join", {
      body: "Open Starbridge to compare digits with it and approve it.",
      tag: `j:${payload.id}`,
    });
    return;
  }
  let answeredAt: string | undefined;
  const item: SealedItem = payload.box
    ? {
        v: 1,
        kind: payload.kind,
        id: payload.id,
        from: payload.from,
        ...(payload.re ? { re: payload.re } : {}),
        ...(payload.wakeAt ? { wakeAt: payload.wakeAt } : {}),
        boxes: [{ to: ctx.device.id, box: payload.box }],
      }
    : await (async () => {
        const stored = await (
          await fetch(`/v1/items/${encodeURIComponent(payload.id)}`, { headers: CLIENT })
        ).json();
        answeredAt = stored.answeredAt;
        return stored.item;
      })();

  if (payload.kind === "decision") {
    const opened = await openPushedDecision(ctx, item);
    if (!answeredAt && !opened.reply) await showDecision(seen, account as string, opened);
  } else if (payload.kind === "permission") {
    const opened = await openPushedPermission(ctx, item);
    if (!answeredAt && !opened.reply) await showPrompt(seen, account as string, opened);
  } else if (payload.kind === "settled") {
    // Checked like any item, so a forged notice cannot clear a real prompt.
    const { settled } = await openSettled(ctx, item);
    answered.add(`${account}/${settled.itemId}`);
    // It may close a prompt or a decision.
    for (const t of [tag(settled.itemId), promptTag(settled.itemId)])
      for (const n of await self.registration.getNotifications({ tag: t })) n.close();
  } else if (payload.kind === "snooze") {
    // The owner put a question off (#571): its notification goes until its time, when the
    // server pushes the snooze once more and the question notifies again, once.
    const z = await openSnooze(ctx, item);
    // A newer snooze of the question, from any device, stands: an older one's return shows nothing.
    if (!(await noteSnoozes(ctx, [z]))) return;
    const until = Date.parse(z.until);
    if (until <= Date.parse(z.at)) return; // Back now: the inbox lists it again, quietly.
    // The server says which push this is; an older one leaves it to this browser's clock, which
    // takes a first push that comes late for the return (#1290).
    const due = payload.due ?? Date.now() >= until - WAKE_SKEW_MS;
    if (!due) {
      // Near or past its time, its return showed the question or will, maybe by a server clock
      // ahead of this one: closing would hide it.
      if (Date.now() < until - WAKE_SKEW_MS)
        for (const n of await self.registration.getNotifications({ tag: tag(z.decisionId) }))
          n.close();
      return;
    }
    if (answered.has(`${account}/${z.decisionId}`)) return;
    const res = await fetch(`/v1/items/${encodeURIComponent(z.decisionId)}`, { headers: CLIENT });
    // A question that can't be read now still needs the owner: the placeholder shows.
    if (!res.ok) throw new Error(`the question read ${res.status}`);
    const stored = await res.json();
    if (stored.answeredAt) return;
    const opened = await openPushedDecision(ctx, stored.item);
    if (!opened.reply) await showDecision(seen, account as string, opened, false, false, true);
  } else if (payload.kind === "waiting") {
    // The agent ran out of other work: notify once more, in place of the question's notification.
    // Back to working, the notification loses its waiting line without a sound (#191).
    const { machine, waiting } = await openWaiting(ctx, item);
    if (answered.has(`${account}/${waiting.decisionId}`)) return;
    // A flip signed before the question's latest snooze, delivered late, is stale: the server
    // pushes none while a snooze is pending, and the snooze's return notifies on its own (#1280).
    const snoozed = (await store.get("snoozes", account as string))?.[waiting.decisionId];
    if (snoozed && Date.parse(waiting.at) < Date.parse(snoozed)) return;
    const res = await fetch(`/v1/items/${encodeURIComponent(waiting.decisionId)}`, {
      headers: CLIENT,
    });
    if (!res.ok) throw new Error(`the question read ${res.status}`);
    const stored = await res.json();
    if (stored.answeredAt) return;
    const opened = await openPushedDecision(ctx, stored.item);
    // Only the machine that asked can say its agent waits on the question.
    if (opened.machine.id !== machine || opened.reply) return;
    await showDecision(seen, account as string, opened, waiting.state === "waiting", true);
  }
}

function maxActions(): number {
  const N = (self as unknown as { Notification?: { maxActions?: number } }).Notification;
  return N?.maxActions ?? 0;
}

/**
 * Whether a notification for this item should not stay up: answered already, or the keys that
 * opened it were deleted since, by a sign-out the push raced (#311).
 */
async function moot(account: string, id: string): Promise<boolean> {
  return answered.has(`${account}/${id}`) || !(await store.get("device", account));
}

/**
 * How far a snooze's time may be ahead of this browser's clock when its second push comes: the
 * server sends it at the time, a little late, by its own clock. A snooze runs at least 5 minutes
 * (lib/snooze.ts), so its first push passes for its second only when it comes over 3 minutes
 * late; servers since #1290 mark which push is which, and this applies only to older ones.
 */
const WAKE_SKEW_MS = 2 * 60_000;

async function showDecision(
  seen: Shown,
  account: string,
  item: InboxItem,
  waiting = false,
  flip = false,
  /** Its snooze is over (#571): it notifies again, once. */
  back = false,
): Promise<void> {
  const done = () => moot(account, item.decision.id);
  const d = item.decision;
  const note = questionNote(item, { waiting, back });
  const options = note.options;
  // Only when every option fits: a notification that hides an option would bias the answer.
  // A decision answered on another page gets one action that opens it.
  const actions = d.answerIn
    ? maxActions() > 0
      ? [{ action: "page", title: `Answer in ${answerPlace(d.answerIn)}` }]
      : []
    : options.length > 0 && options.length <= maxActions()
      ? options.map((o, i) => ({ action: `o${i}`, title: o }))
      : [];
  const options_: NotificationOptions & {
    actions?: { action: string; title: string }[];
    renotify?: boolean;
    silent?: boolean;
  } = {
    body: note.body,
    tag: tag(d.id),
    renotify: waiting || back,
    // A flip back to working replaces the waiting notification quietly.
    silent: flip && !waiting,
    requireInteraction: true,
    // The account it belongs to: an action answers for that account only, whichever is current
    // when it is tapped (#274).
    data: { account, item, options },
    actions,
  };
  if (await done()) return;
  await show(seen, note.title, options_);
  // An answered push, or a sign-out, may have closed nothing while this one was still opening.
  if (await done())
    for (const n of await self.registration.getNotifications({ tag: tag(d.id) })) n.close();
}

/**
 * A permission prompt: the browser cannot ask for an unlock, so every tap opens the page,
 * where the owner reads the full input before allowing it.
 */
async function showPrompt(seen: Shown, account: string, item: PromptItem): Promise<void> {
  const p = item.permission;
  const done = () => moot(account, p.id);
  if (await done()) return;
  const note = promptNote(item);
  await show(seen, note.title, {
    body: note.body,
    tag: promptTag(p.id),
    requireInteraction: true,
  });
  if (await done())
    for (const n of await self.registration.getNotifications({ tag: promptTag(p.id) })) n.close();
}

async function onClick(n: Notification, action: string): Promise<void> {
  const data = n.data as { account?: string; item?: InboxItem; options?: string[] } | undefined;
  const choice = action.startsWith("o") ? data?.options?.[Number(action.slice(1))] : undefined;
  if (data?.item && data.account && choice !== undefined) {
    const reply: Reply = { choice };
    try {
      // Throws when the browser is signed in to another account now: then nothing is answered.
      const ctx = await deviceContext(data.account);
      if (!ctx) throw new Error("this browser is no longer a device of the account");
      await answer(ctx, data.item, reply);
      await tellPages("answered");
      return;
    } catch (e) {
      await self.registration.showNotification("Answer not sent", {
        body: `${data.item.decision.question}\n${e instanceof Error ? e.message : String(e)}`,
        tag: tag(data.item.decision.id),
      });
      return;
    }
  }
  const page = data?.item?.decision.answerIn;
  if (action === "page" && page) {
    await self.clients.openWindow(page.url);
    return;
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = windows[0];
  if (open) await open.focus();
  else await self.clients.openWindow("/");
}
