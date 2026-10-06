"use client";

import type { Settled } from "@starbridge/protocol";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, backingOff } from "@/lib/api";
import type { Boot, Ctx, Inbox, Quotas, Runs } from "@/lib/device";
import { reach, send } from "@/lib/funnel";
import { newestWins } from "@/lib/newest";
import { AnsweredFirst } from "@/lib/outcome";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  notifyAlerts,
  type QuotaSettings,
  saveSettings,
} from "@/lib/quotaSettings";
import { runState } from "@/lib/runs";
import { chimeForNew, unlockSound } from "@/lib/sound";
import type { Device, InboxItem, PromptItem, PromptReply, Reply } from "@/lib/types";

// The protocol code and libsodium load here, after the first paint.
const load = () => import("@/lib/device");
/** Pollers read while the page is visible, and skip their turn while the server is away (#332). */
const polling = () => document.visibilityState === "visible" && !backingOff();

/**
 * A poller's read that skips its turn while the last one is still running, so requests that hang
 * rather than fail (a captive portal, a dead route) don't pile up before the backoff starts.
 */
function single(read: () => Promise<unknown>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    read()
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  };
}

export type Store = {
  boot: Boot | { state: "loading" } | { state: "error"; error: string };
  inbox: Inbox;
  /** The inbox came back once since boot: until then, an empty one means nothing yet. */
  inboxLoaded: boolean;
  quotas?: Quotas;
  runs?: Runs;
  /** Runs boot again, after sign-in, setup, pairing or recovery. */
  reload: () => Promise<void>;
  answer: (item: InboxItem, reply: Reply) => Promise<void>;
  /** Puts the question off until `until` (#571), or brings it back now with the current time. */
  snooze: (item: InboxItem, until: string) => Promise<void>;
  /** Replaces the context after a directory write (approve, revoke). */
  update: (ctx: Ctx) => void;
  refreshQuotas: () => Promise<void>;
  /** Asks every machine to read CodexBar again, then loads quotas: Android's pull to refresh. */
  askQuotas: () => Promise<void>;
  /** This browser's quota settings (lib/quotaSettings.ts). */
  quotaSettings: QuotaSettings;
  setQuotaSettings: (s: QuotaSettings) => void;
  /** Permission prompts open now, and those that just closed (Prompts.tsx). */
  prompts: PromptItem[];
  answerPrompt: (item: PromptItem, reply: PromptReply) => Promise<void>;
  /** The last 7 days of prompts, once the log page loaded them. */
  promptLog?: PromptItem[];
  loadPromptLog: () => Promise<void>;
  /** A directory member's name, for "Answered from Pixel". */
  deviceName: (id: string) => string;
  /** The mockups' devices, on /sample only (SampleProvider), where no device is ready. */
  sampleDevices?: Device[];
  /**
   * Why no machine's item shows: the server holds back directory entries a machine has seen
   * (#362). Settings still work, so the owner can revoke.
   */
  withheld?: string;
};

export const StoreContext = createContext<Store | null>(null);
const Ctx_ = StoreContext;

const POLL_MS = 20_000;
/** While a prompt waits, it leaves within a second or two of being settled elsewhere. */
const PROMPT_POLL_MS = 1_500;
/**
 * Runs skip Web Push (PROTOCOL.md, "Push"), so the page polls them while it is visible: often
 * while one runs, so its steps show about when the phone gets them by push (#188).
 */
const RUNS_POLL_MS = 10_000;
const LIVE_RUNS_POLL_MS = 2_000;
/** Quotas skip Web Push too; the uploader posts every 5 minutes. */
const QUOTA_POLL_MS = 60_000;
/**
 * A device that just joined reads no snapshot until each machine posts one sealed to it, which
 * machines do within seconds of the join: until then the page looks every few seconds.
 */
const QUOTA_JOIN_POLL_MS = 3_000;
const QUOTA_JOIN_MS = 30_000;
/** How long a refresh holds for the machines' new snapshots, as Android's QUOTA_ASK_SECONDS. */
const QUOTA_ASK_SECONDS = 25;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [boot, setBoot] = useState<Store["boot"]>({ state: "loading" });
  const [inbox, setInbox] = useState<Inbox>({ items: [], rejected: [] });
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [quotas, setQuotas] = useState<Quotas>();
  const [withheld, setWithheld] = useState<string>();
  const [quotaSettings, setSettingsState] = useState<QuotaSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(quotaSettings);
  settingsRef.current = quotaSettings;
  useEffect(() => setSettingsState(loadSettings()), []);
  const setQuotaSettings = useCallback((s: QuotaSettings) => {
    saveSettings(s);
    setSettingsState(s);
  }, []);
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [promptLog, setPromptLog] = useState<PromptItem[]>();
  const promptsRef = useRef(prompts);
  promptsRef.current = prompts;
  const settledRef = useRef<{ cursor?: string; byKey: Map<string, Settled> }>({
    byKey: new Map(),
  });
  const [runs, setRuns] = useState<Runs>();
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  // Inbox reads overlap (a load, pushes, polls): only the newest to start may land (#547).
  const inboxRead = useRef(newestWins());
  const ctx = boot.state === "ready" ? boot.ctx : undefined;

  // The launch funnel's signed-in steps, in the browser that created the account (#559, #590).
  useEffect(() => {
    if (!ctx) return;
    const active = (role: string) =>
      [...ctx.dir.members.values()].filter((m) => m.active && m.member.role === role).length;
    reach(ctx.account, (step) => {
      if (step === "first-machine") return active("machine") > 0;
      if (step === "second-device") return active("device") > 1;
      if (step !== "first-answer") return false;
      // Answered by a device, not closed by its machine (a timeout, the keyboard).
      const item = inbox.items
        .filter((i) => i.answeredAt && !i.settled)
        .sort((x, y) => (x.answeredAt ?? "").localeCompare(y.answeredAt ?? ""))[0];
      if (!item) return false;
      // Another device's answer shows here only once its machine took it: until then, no kind.
      const reply = item.reply ?? item.answeredBy?.reply;
      if (!reply) return true;
      return { kind: "choice" in reply ? "choice" : "text" in reply ? "text" : "done" };
    });
  }, [ctx, inbox]);

  // Installed as an app from the landing page or the app, signed in or not (#590).
  useEffect(() => {
    const installed = () => send("pwa-install");
    window.addEventListener("appinstalled", installed);
    return () => window.removeEventListener("appinstalled", installed);
  }, []);

  /** Bumped by `forget`: a load started before it keeps nothing it read. */
  const generation = useRef(0);
  /** Set to `reload` below; loads call it when the server ends the session. */
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  /** Drops every machine's item the page holds in memory. */
  const forget = useCallback(() => {
    generation.current++;
    // A read that starts before React renders the empty inbox must not reuse the old cursor.
    inboxRef.current = { items: [], rejected: [] };
    setInbox(inboxRef.current);
    setPrompts([]);
    setPromptLog(undefined);
    setQuotas(undefined);
    setRuns(undefined);
  }, []);

  /**
   * Runs a load of machines' items. While the server holds back directory entries a machine has
   * seen, every machine's items are hidden and the reason shows instead (#362).
   */
  const holding = useCallback(
    async <T,>(read: () => Promise<T>): Promise<T | undefined> => {
      const d = await load();
      const gen = generation.current;
      try {
        const got = await read();
        if (gen !== generation.current) return undefined;
        setWithheld(undefined);
        return got;
      } catch (e) {
        // The server ended this session: revoked, signed out elsewhere or expired. Boot says which.
        if (e instanceof d.ApiError && e.status === 401) {
          reloadRef.current();
          return undefined;
        }
        if (!(e instanceof d.Withheld)) throw e;
        setWithheld(e.message);
        // Their buttons would still offer answers the hold refuses.
        const reg = await navigator.serviceWorker?.getRegistration("/").catch(() => undefined);
        for (const n of (await reg?.getNotifications().catch(() => [])) ?? []) n.close();
        // From the start once the hold ends: the cursor moved past what is hidden now.
        forget();
        return undefined;
      }
    },
    [forget],
  );

  const boot1 = useCallback(async (): Promise<Store["boot"]["state"]> => {
    try {
      const d = await load();
      const b = await d.boot();
      setBoot(b);
      // Signed out, revoked or broken: nothing decrypted stays behind the page that says so.
      if (b.state !== "ready") {
        forget();
        settledRef.current = { byKey: new Map() };
      }
      if (b.state === "ready") {
        let landed = () => false;
        const loaded = await holding(() => {
          landed = inboxRead.current();
          return d.loadInbox(b.ctx);
        });
        if (loaded && landed()) {
          inboxRef.current = loaded;
          setInbox(loaded);
        }
        setInboxLoaded(true);
        const push = await import("@/lib/push");
        push.registerWorker();
        push.resubscribe().catch(() => {});
      }
      return b.state;
    } catch (e) {
      setBoot({ state: "error", error: e instanceof Error ? e.message : String(e) });
      return "error";
    }
  }, [forget, holding]);

  // One boot at a time: every poller that meets a 401 asks for one, and a second boot after the
  // first deleted a revoked browser's keys would replace "removed by" with Join. A request during
  // a boot that ended ready boots once more.
  const reloading = useRef<Promise<void>>(undefined);
  const again = useRef(false);
  const reload = useCallback(() => {
    if (reloading.current) {
      again.current = true;
      return reloading.current;
    }
    const run = async () => {
      let state: Store["boot"]["state"];
      do {
        again.current = false;
        state = await boot1();
      } while (again.current && state === "ready");
    };
    reloading.current = run().finally(() => {
      reloading.current = undefined;
    });
    return reloading.current;
  }, [boot1]);
  reloadRef.current = reload;

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
    let fresh: Awaited<ReturnType<typeof d.reverify>>;
    try {
      fresh = await d.reverify(was);
    } catch (e) {
      // The server ended this session: revoked, signed out elsewhere or expired. Boot says which.
      if (!(e instanceof d.ApiError && e.status === 401)) throw e;
      reload();
      return undefined;
    }
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
    // The turn is taken with the base the read starts from, right before it lists.
    let landed = () => false;
    const loaded = await holding(() => {
      landed = inboxRead.current();
      return d.loadInbox(fresh, inboxRef.current);
    });
    if (!loaded || !landed()) return;
    // The next read starts before React renders this one.
    inboxRef.current = loaded;
    setInbox(loaded);
  }, [current, holding]);

  /**
   * Reads the open prompts and the settled notices since the last read. A prompt that left the
   * open list stays a moment, closed, saying where it was settled.
   */
  const refreshPrompts = useCallback(async () => {
    const fresh = await current();
    if (!fresh) return;
    const d = await load();
    const read = await holding(() =>
      Promise.all([d.loadPrompts(fresh), d.loadSettled(fresh, settledRef.current.cursor)]),
    );
    if (!read) return;
    const [open, notices] = read;
    const byKey = settledRef.current.byKey;
    for (const [k, v] of notices.settled) byKey.set(k, v);
    settledRef.current.cursor = notices.cursor;
    const at = Date.now();
    setPrompts((was) => {
      const openIds = new Set(open.map((p) => p.permission.id));
      const closed = was
        .filter((p) => !openIds.has(p.permission.id))
        // Closed, not answered: the server also drops a prompt from the open list when it
        // expires, so only a settled notice says who answered it.
        .map((p) => ({ ...p, closedAt: p.closedAt ?? at }))
        .filter((p) => at - (p.closedAt ?? at) < 3_000);
      const withNotice = (p: PromptItem) => {
        const st = byKey.get(`${p.machine.id}/${p.permission.id}`);
        return st ? { ...p, settled: st } : p;
      };
      return [...open, ...closed].map(withNotice);
    });
  }, [current, holding]);

  const fetchQuotas = useCallback(async () => {
    const fresh = await current();
    if (!fresh) return;
    const d = await load();
    const next = await holding(() => d.loadQuotas(fresh));
    if (!next) return;
    setQuotas(next);
    await notifyAlerts(next.cards, settingsRef.current);
    return next;
  }, [current, holding]);
  const refreshQuotas = useCallback(async () => {
    await fetchQuotas();
  }, [fetchQuotas]);
  const askQuotas = useCallback(async () => {
    // Asked too often, offline, or a server without asks: the load shows what the server holds.
    await api.askQuota(QUOTA_ASK_SECONDS).catch(() => {});
    await fetchQuotas();
  }, [fetchQuotas]);

  // While the page is visible, or in the background once a provider notifies.
  useEffect(() => {
    if (!ctx) return;
    const started = Date.now();
    let soon: ReturnType<typeof setTimeout> | undefined;
    const read = single(() =>
      fetchQuotas().then((next) => {
        clearTimeout(soon);
        if (next?.cards.length === 0 && Date.now() - started < QUOTA_JOIN_MS)
          soon = setTimeout(tick, QUOTA_JOIN_POLL_MS);
      }),
    );
    const tick = () => {
      if (backingOff()) return;
      if (document.visibilityState === "visible" || settingsRef.current.notify.length > 0) read();
    };
    tick();
    const timer = setInterval(tick, QUOTA_POLL_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(soon);
    };
  }, [ctx, fetchQuotas]);

  const refreshRuns = useCallback(async () => {
    const fresh = await current();
    if (!fresh) return;
    const d = await load();
    const next = await holding(() => d.loadRuns(fresh));
    if (next) setRuns(next);
  }, [current, holding]);

  const runLive = !!runs?.items.some((i) => runState(i.run, Date.now()) === "running");
  useEffect(() => {
    if (!ctx) return;
    const read = single(refreshRuns);
    const tick = () => {
      if (polling()) read();
    };
    tick();
    const timer = setInterval(tick, runLive ? LIVE_RUNS_POLL_MS : RUNS_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ctx, refreshRuns, runLive]);

  // Poll while the page is visible, and refresh as soon as the service worker sees a push.
  useEffect(() => {
    if (!ctx) return;
    const readInbox = single(refreshInbox);
    const readPrompts = single(refreshPrompts);
    const tick = () => {
      if (!polling()) return;
      readInbox();
      readPrompts();
    };
    const timer = setInterval(tick, POLL_MS);
    refreshPrompts().catch(() => {});
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "starbridge:push-error") console.error("push:", e.data.error);
      if (e.data?.type !== "starbridge:push") return;
      if (["decision", "permission", "waiting"].includes(e.data.kind)) chimeForNew();
      if (e.data.kind === "quota") refreshQuotas().catch(() => {});
      else if (["permission", "settled", "answered"].includes(e.data.kind))
        refreshPrompts().catch(() => {});
      // A settled notice may close a decision too.
      if (e.data.kind !== "quota" && e.data.kind !== "permission") refreshInbox().catch(() => {});
    };
    document.addEventListener("visibilitychange", tick);
    // Back online: read at once rather than at the next tick (lib/api.ts ends its backoff too).
    window.addEventListener("online", tick);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    unlockSound();
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [ctx, refreshInbox, refreshQuotas, refreshPrompts]);

  // While a prompt waits or just closed, poll fast so a keyboard answer clears it at once.
  const busy = prompts.length > 0;
  useEffect(() => {
    if (!ctx || !busy) return;
    const read = single(refreshPrompts);
    const timer = setInterval(() => {
      if (polling()) read();
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
        if (e instanceof d.ApiError && e.status === 401) reload();
        if (e instanceof d.ApiError && (e.code === "already-answered" || e.code === "expired"))
          await refreshPrompts();
        else throw e;
      }
    },
    [ctx, refreshPrompts, reload],
  );

  const loadPromptLog = useCallback(async () => {
    const fresh = await current();
    if (!fresh) return;
    const d = await load();
    const log = await holding(() => d.loadPromptLog(fresh));
    if (log) setPromptLog(log);
  }, [current, holding]);

  const deviceName = useCallback(
    (id: string) =>
      id === ctx?.device.id ? "this browser" : (ctx?.dir.members.get(id)?.member.name ?? id),
    [ctx],
  );

  const snooze = useCallback(
    async (item: InboxItem, until: string) => {
      if (!ctx) return;
      const d = await load();
      try {
        const z = await d.snooze(ctx, item, until);
        // The server pushes the other devices; this browser closes its own notification.
        if (Date.parse(z.until) > Date.now()) {
          const reg = await navigator.serviceWorker?.getRegistration("/").catch(() => undefined);
          const tag = `d:${item.decision.id}`;
          for (const n of (await reg?.getNotifications({ tag }).catch(() => [])) ?? []) n.close();
        }
        // As an answer: a read in flight must not land without it.
        inboxRead.current()();
        setInbox((all) => ({
          ...all,
          snoozes: { ...all.snoozes, [item.decision.id]: { until: z.until, at: z.at } },
          items: all.items.map((i) => {
            if (i.decision.id !== item.decision.id) return i;
            const { snoozedUntil: _, ...rest } = i;
            return Date.parse(z.until) > Date.parse(z.at)
              ? { ...rest, snoozedUntil: z.until }
              : rest;
          }),
        }));
      } catch (e) {
        if (e instanceof d.ApiError && e.status === 401) reload();
        if (e instanceof d.ApiError && e.code === "already-answered") await refreshInbox();
        throw e;
      }
    },
    [ctx, reload, refreshInbox],
  );
  const answer = useCallback(
    async (item: InboxItem, reply: Reply) => {
      if (!ctx) return;
      const d = await load();
      try {
        const answeredAt = await d.answer(ctx, item, reply);
        // A read already in flight may list the decision without this reply and move its cursor
        // past it: it must not land. The next read finds the reply in the sent answers.
        inboxRead.current()();
        setInbox((all) => ({
          ...all,
          items: all.items.map((i) =>
            i.decision.id === item.decision.id ? { ...i, answeredAt, reply } : i,
          ),
        }));
      } catch (e) {
        if (e instanceof d.ApiError && e.status === 401) reload();
        if (!(e instanceof d.ApiError && e.code === "already-answered")) throw e;
        // Answered on another device in the meantime: show it answered, and that this one lost.
        await refreshInbox();
        throw new AnsweredFirst();
      }
    },
    [ctx, refreshInbox, reload],
  );

  const update = useCallback((next: Ctx) => setBoot({ state: "ready", ctx: next }), []);

  return (
    <Ctx_.Provider
      value={{
        boot,
        inbox,
        inboxLoaded,
        quotas,
        runs,
        reload,
        answer,
        snooze,
        update,
        refreshQuotas,
        askQuotas,
        quotaSettings,
        setQuotaSettings,
        prompts,
        answerPrompt,
        promptLog,
        loadPromptLog,
        deviceName,
        withheld,
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
