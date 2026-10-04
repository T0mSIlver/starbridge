"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Boot, Ctx, Inbox, Quotas } from "@/lib/device";
import type { InboxItem, Reply } from "@/lib/types";

// The protocol code and libsodium load here, after the first paint.
const load = () => import("@/lib/device");

type Store = {
  boot: Boot | { state: "loading" } | { state: "error"; error: string };
  inbox: Inbox;
  quotas?: Quotas;
  /** Runs boot again, after sign-in, setup, pairing or recovery. */
  reload: () => Promise<void>;
  answer: (item: InboxItem, reply: Reply) => Promise<void>;
  /** Replaces the context after a directory write (approve, revoke). */
  update: (ctx: Ctx) => void;
  refreshQuotas: () => Promise<void>;
};

const Ctx_ = createContext<Store | null>(null);

const POLL_MS = 20_000;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [boot, setBoot] = useState<Store["boot"]>({ state: "loading" });
  const [inbox, setInbox] = useState<Inbox>({ items: [], rejected: [] });
  const [quotas, setQuotas] = useState<Quotas>();
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const ctx = boot.state === "ready" ? boot.ctx : undefined;

  const reload = useCallback(async () => {
    try {
      const d = await load();
      const b = await d.boot();
      setBoot(b);
      if (b.state === "ready") {
        setInbox(await d.loadInbox(b.ctx));
        const push = await import("@/lib/push");
        push.registerWorker();
        push.resubscribe().catch(() => {});
      }
    } catch (e) {
      setBoot({ state: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const refreshInbox = useCallback(async () => {
    if (!ctx) return;
    const d = await load();
    setInbox(await d.loadInbox(ctx, inboxRef.current));
  }, [ctx]);

  const refreshQuotas = useCallback(async () => {
    if (!ctx) return;
    const d = await load();
    setQuotas(await d.loadQuotas(ctx));
  }, [ctx]);

  // Poll while the page is visible, and refresh as soon as the service worker sees a push.
  useEffect(() => {
    if (!ctx) return;
    const tick = () => {
      if (document.visibilityState === "visible") refreshInbox().catch(() => {});
    };
    const timer = setInterval(tick, POLL_MS);
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "starbridge:push-error") console.error("push:", e.data.error);
      if (e.data?.type !== "starbridge:push") return;
      if (e.data.kind === "quota") refreshQuotas().catch(() => {});
      else refreshInbox().catch(() => {});
    };
    document.addEventListener("visibilitychange", tick);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [ctx, refreshInbox, refreshQuotas]);

  const answer = useCallback(
    async (item: InboxItem, reply: Reply) => {
      if (!ctx) return;
      const d = await load();
      try {
        const answeredAt = await d.answer(ctx, item, reply);
        setInbox((all) => ({
          ...all,
          items: all.items.map((i) =>
            i.decision.id === item.decision.id ? { ...i, answeredAt, reply } : i,
          ),
        }));
      } catch (e) {
        // Answered on another device in the meantime: show it answered.
        if (e instanceof d.ApiError && e.code === "already-answered") await refreshInbox();
        else throw e;
      }
    },
    [ctx, refreshInbox],
  );

  const update = useCallback((next: Ctx) => setBoot({ state: "ready", ctx: next }), []);

  return (
    <Ctx_.Provider value={{ boot, inbox, quotas, reload, answer, update, refreshQuotas }}>
      {children}
    </Ctx_.Provider>
  );
}

export function useApp(): Store {
  const store = useContext(Ctx_);
  if (!store) throw new Error("useApp outside AppProvider");
  return store;
}

/** The ready device's context; only for screens rendered behind the gate. */
export function useDevice(): Ctx {
  const { boot } = useApp();
  if (boot.state !== "ready") throw new Error("useDevice before the device is ready");
  return boot.ctx;
}
