/// <reference lib="webworker" />
// The service worker: opens Web Push payloads (PROTOCOL.md, "Push") with this browser's device
// key, verifies them against the pinned directory, and shows the decision with its options as
// notification actions where the browser supports them. Built to public/sw.js by `bun run sw`.
import type { QuotaSnapshot, SealedItem } from "@starbridge/protocol";
import { answer, deviceContext, openPushedDecision, openPushedQuota } from "../lib/device";
import * as store from "../lib/store";
import type { InboxItem, Reply } from "../lib/types";

declare const self: ServiceWorkerGlobalScope;

/** What the server pushes: a new item with this device's box when it fits, or "answered". */
type Payload =
  | {
      v: 1;
      kind: "decision" | "quota" | "answer";
      id: string;
      from: string;
      re?: string;
      box?: string;
    }
  | { v: 1; kind: "answered"; id: string };

const tag = (decisionId: string) => `d:${decisionId}`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  e.waitUntil(
    onPush(e.data?.text() ?? "").catch(async (err) => {
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
  if (payload.kind === "answered") {
    // Answered elsewhere: the question is settled, so its notification goes.
    for (const n of await self.registration.getNotifications({ tag: tag(payload.id) })) n.close();
    return;
  }
  if (payload.kind === "answer") return;

  const account = await store.get("current");
  const ctx = account ? await deviceContext(account) : undefined;
  if (!ctx) return;
  const item: SealedItem = payload.box
    ? {
        v: 1,
        kind: payload.kind,
        id: payload.id,
        from: payload.from,
        ...(payload.re ? { re: payload.re } : {}),
        boxes: [{ to: ctx.device.id, box: payload.box }],
      }
    : (await (await fetch(`/v1/items/${encodeURIComponent(payload.id)}`)).json()).item;

  if (payload.kind === "decision") await showDecision(await openPushedDecision(ctx, item));
  else await showAlerts(account as string, await openPushedQuota(ctx, item));
}

function maxActions(): number {
  const N = (self as unknown as { Notification?: { maxActions?: number } }).Notification;
  return N?.maxActions ?? 0;
}

/** First lines of the context, without code fences, for the notification body. */
function summary(context: string): string {
  const text = context
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("```"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

async function showDecision(item: InboxItem): Promise<void> {
  const d = item.decision;
  const options = d.recommended
    ? [d.recommended, ...d.options.filter((o) => o !== d.recommended)]
    : d.options;
  // Only when every option fits: a notification that hides an option would bias the answer.
  const actions =
    options.length > 0 && options.length <= maxActions()
      ? options.map((o, i) => ({ action: `o${i}`, title: o }))
      : [];
  const options_: NotificationOptions & { actions?: { action: string; title: string }[] } = {
    body: `${d.source.machine} · ${d.source.project}\n${summary(d.context)}`,
    tag: tag(d.id),
    requireInteraction: true,
    data: { item, options },
    actions,
  };
  await self.registration.showNotification(d.question, options_);
}

async function showAlerts(account: string, snapshot: QuotaSnapshot): Promise<void> {
  // Snapshots arrive every few minutes; notify each alert once per reset.
  const seen = new Set((await store.get("alerts", account)) ?? []);
  for (const a of snapshot.alerts) {
    const key = `${a.kind}/${a.provider}/${a.window}/${a.resetsAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title =
      a.kind === "runs-out"
        ? `${a.provider} will run out before it resets`
        : `${a.provider} resets with ${Math.round(a.unusedPercent)}% unused`;
    await self.registration.showNotification(title, { tag: `q:${a.provider}/${a.window}` });
  }
  await store.put("alerts", [...seen].slice(-200), account);
}

async function onClick(n: Notification, action: string): Promise<void> {
  const data = n.data as { item?: InboxItem; options?: string[] } | undefined;
  const choice = action.startsWith("o") ? data?.options?.[Number(action.slice(1))] : undefined;
  if (data?.item && choice !== undefined) {
    const reply: Reply = { choice };
    const account = await store.get("current");
    const ctx = account ? await deviceContext(account) : undefined;
    try {
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
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = windows[0];
  if (open) await open.focus();
  else await self.clients.openWindow("/");
}
