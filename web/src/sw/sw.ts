/// <reference lib="webworker" />
// The service worker: opens Web Push payloads (PROTOCOL.md, "Push") with this browser's device
// key, verifies them against the pinned directory, and shows the decision with its options as
// notification actions where the browser supports them. Built to public/sw.js by `bun run sw`.
import type { SealedItem } from "@starbridge/protocol";
import { CLIENT } from "../lib/api";
import {
  answer,
  deviceContext,
  openPushedDecision,
  openPushedPermission,
  openSettled,
  openWaiting,
  Withheld,
} from "../lib/device";
import { answerPlace } from "../lib/outcome";
import * as store from "../lib/store";
import type { InboxItem, PromptItem, Reply } from "../lib/types";

declare const self: ServiceWorkerGlobalScope;

/** What the server pushes: a new item with this device's box when it fits, or "answered". */
type Payload =
  | {
      v: 1;
      kind: "decision" | "quota" | "answer" | "permission" | "settled" | "waiting";
      id: string;
      from: string;
      re?: string;
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
  e.waitUntil(
    onPush(e.data?.text() ?? "").catch(async (err) => {
      // Held (#362): the notifications already up would still let the owner answer from them.
      if (err instanceof Withheld)
        for (const n of await self.registration.getNotifications()) n.close();
      // A push that fails to open or verify shows nothing; open pages log why.
      for (const c of await self.clients.matchAll({ type: "window" }))
        c.postMessage({ type: "starbridge:push-error", error: String(err) });
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(onClick(e.notification, e.action));
});

async function tellPages(kind: string): Promise<void> {
  for (const c of await self.clients.matchAll({ type: "window" }))
    c.postMessage({ type: "starbridge:push", kind });
}

async function onPush(text: string): Promise<void> {
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
  if (payload.kind === "join") {
    await self.registration.showNotification("A device wants to join", {
      body: "Open Starbridge to compare digits with it and approve it.",
      tag: `j:${payload.id}`,
    });
    return;
  }

  const ctx = account ? await deviceContext(account) : undefined;
  if (!ctx) return;
  let answeredAt: string | undefined;
  const item: SealedItem = payload.box
    ? {
        v: 1,
        kind: payload.kind,
        id: payload.id,
        from: payload.from,
        ...(payload.re ? { re: payload.re } : {}),
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
    if (!answeredAt && !opened.reply) await showDecision(account as string, opened);
  } else if (payload.kind === "permission") {
    const opened = await openPushedPermission(ctx, item);
    if (!answeredAt && !opened.reply) await showPrompt(account as string, opened);
  } else if (payload.kind === "settled") {
    // Checked like any item, so a forged notice cannot clear a real prompt.
    const { settled } = await openSettled(ctx, item);
    answered.add(`${account}/${settled.itemId}`);
    // It may close a prompt or a decision.
    for (const t of [tag(settled.itemId), promptTag(settled.itemId)])
      for (const n of await self.registration.getNotifications({ tag: t })) n.close();
  } else if (payload.kind === "waiting") {
    // The agent ran out of other work: notify once more, in place of the question's notification.
    // Back to working, the notification loses its waiting line without a sound (#191).
    const { machine, waiting } = await openWaiting(ctx, item);
    if (answered.has(`${account}/${waiting.decisionId}`)) return;
    const res = await fetch(`/v1/items/${encodeURIComponent(waiting.decisionId)}`, {
      headers: CLIENT,
    });
    if (!res.ok) return;
    const stored = await res.json();
    if (stored.answeredAt) return;
    const opened = await openPushedDecision(ctx, stored.item);
    // Only the machine that asked can say its agent waits on the question.
    if (opened.machine.id !== machine || opened.reply) return;
    await showDecision(account as string, opened, waiting.state === "waiting", true);
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

/** First lines of the context, without code fences, for the notification body. */
function summary(context: string): string {
  const text = context
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("```"))
    .join(" ")
    // Inline code reads as plain text: a notification shows no formatting (#191).
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

async function showDecision(
  account: string,
  item: InboxItem,
  waiting = false,
  flip = false,
): Promise<void> {
  const done = () => moot(account, item.decision.id);
  const d = item.decision;
  const options = d.recommended
    ? [d.recommended, ...d.options.filter((o) => o !== d.recommended)]
    : d.options;
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
    body: `${waiting ? "Waiting · " : ""}${d.source.machine} · ${d.source.project}\n${summary(d.context)}`,
    tag: tag(d.id),
    renotify: waiting,
    // A flip back to working replaces the waiting notification quietly.
    silent: flip && !waiting,
    requireInteraction: true,
    // The account it belongs to: an action answers for that account only, whichever is current
    // when it is tapped (#274).
    data: { account, item, options },
    actions,
  };
  if (await done()) return;
  await self.registration.showNotification(d.question, options_);
  // An answered push, or a sign-out, may have closed nothing while this one was still opening.
  if (await done())
    for (const n of await self.registration.getNotifications({ tag: tag(d.id) })) n.close();
}

/**
 * A permission prompt: the browser cannot ask for an unlock, so every tap opens the page,
 * where the owner reads the full input before allowing it.
 */
async function showPrompt(account: string, item: PromptItem): Promise<void> {
  const p = item.permission;
  const done = () => moot(account, p.id);
  if (await done()) return;
  await self.registration.showNotification(`${p.tool} on ${p.source.machine}`, {
    body: `${p.source.project}\n${p.summary}`,
    tag: promptTag(p.id),
    requireInteraction: true,
  });
  if (await done())
    for (const n of await self.registration.getNotifications({ tag: promptTag(p.id) })) n.close();
}

async function onClick(n: Notification, action: string): Promise<void> {
  const data = n.data as { account?: string; item?: InboxItem; options?: string[] } | undefined;
  const choice = action.startsWith("o") ? data?.options?.[Number(action.slice(1))] : undefined;
  // A notification from before it carried its account opens the page instead of answering.
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
