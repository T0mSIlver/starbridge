"use client";

import type { Settled } from "@starbridge/protocol";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Boot, Ctx, Inbox, Quotas } from "@/lib/device";
import type { InboxItem, PromptItem, PromptReply, Reply } from "@/lib/types";

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
  /** Permission prompts open now, and those that just closed (Prompts.tsx). */
  prompts: PromptItem[];
  answerPrompt: (item: PromptItem, reply: PromptReply) => Promise<void>;
  /** The last 7 days of prompts, once the log page loaded them. */
  promptLog?: PromptItem[];
  loadPromptLog: () => Promise<void>;
  /** A directory member's name, for "Answered from Pixel". */
  deviceName: (id: string) => string;
};

const Ctx_ = createContext<Store | null>(null);

const POLL_MS = 20_000;
/** While a prompt waits, it leaves within a second or two of being settled elsewhere. */
const PROMPT_POLL_MS = 1_500;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [boot, setBoot] = useState<Store["boot"]>({ state: "loading" });
  const [inbox, setInbox] = useState<Inbox>({ items: [], rejected: [] });
  const [quotas, setQuotas] = useState<Quotas>();
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [promptLog, setPromptLog] = useState<PromptItem[]>();
  const promptsRef = useRef(prompts);
  promptsRef.current = prompts;
  const settledRef = useRef<{ cursor?: string; byKey: Map<string, Settled> }>({
    byKey: new Map(),
  });
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

  // The directory as last verified; read again before every load.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const current = useCallback(async () => {
    const was = ctxRef.current;
    if (!was) return undefined;
    const d = await load();
    const fresh = await d.reverify(was);
    if (!fresh) {
      // Revoked from another device: boot shows why.
      await reload();
      return undefined;
    }
    ctxRef.current = fresh;
    if (fresh.dir.length !== was.dir.length) setBoot({ state: "ready", ctx: fresh });
    return fresh;
  }, [reload]);

  const refreshInbox = useCallback(async () => {
    const fresh = await current();
    if (!fresh) return;
    const d = await load();
    setInbox(await d.loadInbox(fresh, inboxRef.current));
  }, [current]);

  /**
   * Reads the open prompts and the settled notices since the last read. A prompt that left the
   * open list stays a moment, closed, saying where it was settled.
   */
  const refreshPrompts = useCallback(async () => {
    const fresh = await current();
    if (!fresh) return;
    const d = await load();
    const [open, notices] = await Promise.all([
      d.loadPrompts(fresh),
      d.loadSettled(fresh, settledRef.current.cursor),
    ]);
    const byKey = settledRef.current.byKey;
    for (const [k, v] of notices.settled) byKey.set(k, v);
    settledRef.current.cursor = notices.cursor;
    const at = Date.now();
    setPrompts((was) => {
      const openIds = new Set(open.map((p) => p.permission.id));
      const closed = was
        .filter((p) => !openIds.has(p.permission.id))
        .map((p) => ({
          ...p,
          answeredAt: p.answeredAt ?? new Date(at).toISOString(),
          closedAt: p.closedAt ?? at,
        }))
        .filter((p) => at - (p.closedAt ?? at) < 3_000);
      const withNotice = (p: PromptItem) => {
        const st = byKey.get(`${p.machine.id}/${p.permission.id}`);
        return st ? { ...p, settled: st } : p;
      };
      return [...open, ...closed].map(withNotice);
    });
  }, [current]);

  const refreshQuotas = useCallback(async () => {
    const fresh = await current();
    if (!fresh) return;
    const d = await load();
    setQuotas(await d.loadQuotas(fresh));
  }, [current]);

  // Poll while the page is visible, and refresh as soon as the service worker sees a push.
  useEffect(() => {
    if (!ctx) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      refreshInbox().catch(() => {});
      refreshPrompts().catch(() => {});
    };
    const timer = setInterval(tick, POLL_MS);
    refreshPrompts().catch(() => {});
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "starbridge:push-error") console.error("push:", e.data.error);
      if (e.data?.type !== "starbridge:push") return;
      if (e.data.kind === "quota") refreshQuotas().catch(() => {});
      else if (["permission", "settled", "answered"].includes(e.data.kind))
        refreshPrompts().catch(() => {});
      if (e.data.kind !== "quota" && e.data.kind !== "permission" && e.data.kind !== "settled")
        refreshInbox().catch(() => {});
    };
    document.addEventListener("visibilitychange", tick);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [ctx, refreshInbox, refreshQuotas, refreshPrompts]);

  // While a prompt waits or just closed, poll fast so a keyboard answer clears it at once.
  const busy = prompts.length > 0;
  useEffect(() => {
    if (!ctx || !busy) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshPrompts().catch(() => {});
    }, PROMPT_POLL_MS);
    return () => clearInterval(timer);
  }, [ctx, busy, refreshPrompts]);

  const answerPrompt = useCallback(
    async (item: PromptItem, reply: PromptReply) => {
      if (!ctx) return;
      const d = await load();
      try {
        const answeredAt = await d.answerPermission(ctx, item, reply);
        const at = Date.now();
        setPrompts((all) =>
          all.map((p) =>
            p.permission.id === item.permission.id ? { ...p, answeredAt, reply, closedAt: at } : p,
          ),
        );
      } catch (e) {
        // Settled at the keyboard or answered elsewhere meanwhile: show where.
        if (e instanceof d.ApiError && (e.code === "already-answered" || e.code === "expired"))
          await refreshPrompts();
        else throw e;
      }
    },
    [ctx, refreshPrompts],
  );

  const loadPromptLog = useCallback(async () => {
    const fresh = await current();
    if (!fresh) return;
    const d = await load();
    setPromptLog(await d.loadPromptLog(fresh));
  }, [current]);

  const deviceName = useCallback(
    (id: string) =>
      id === ctx?.device.id ? "this browser" : (ctx?.dir.members.get(id)?.member.name ?? id),
    [ctx],
  );

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
    <Ctx_.Provider
      value={{
        boot,
        inbox,
        quotas,
        reload,
        answer,
        update,
        refreshQuotas,
        prompts,
        answerPrompt,
        promptLog,
        loadPromptLog,
        deviceName,
      }}
    >
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
