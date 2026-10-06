import { randomBytes } from "node:crypto";
import { alertsFor, type QuotaAlert, type QuotaSnapshot, seal } from "@starbridge/protocol";
import { collect, type ProviderQuota } from "./codexbar";
import type { LastQuota } from "./config";
import { type Ctx, devices, iso, parseDuration, refreshDirectory, session } from "./context";

export interface QuotaOpts {
  providers: string[];
  interval?: string;
  once?: boolean;
  codexbar?: string;
}

export function snapshot(providers: ProviderQuota[], to: string[], now: Date): QuotaSnapshot {
  return {
    v: 1,
    id: `q_${randomBytes(12).toString("base64url")}`,
    to,
    takenAt: iso(now),
    providers,
    // Stale windows raise nothing: their pace is from when they were read.
    alerts: providers.flatMap((p) =>
      p.updatedAt ? [] : p.windows.flatMap((w) => alertsFor(p.provider, w, now)),
    ),
  };
}

/** One alert per window, kind and threshold; its reset tells the cycles apart. */
export const alertKey = (a: QuotaAlert) =>
  `${a.provider}/${a.window}/${a.kind}${a.kind === "low" ? `/${a.threshold}` : ""}`;

/**
 * Marks `notify` on each alert not yet raised in its window's cycle, and returns the raised
 * alerts to keep: these and the earlier ones whose reset has not passed. A reset that moved
 * less than half its window (5 minutes at least, or with no known length) is the same cycle,
 * as CodexBar treats it, since providers correct reset times by a few seconds.
 */
export function raise(
  snap: QuotaSnapshot,
  raised: Record<string, string>,
  now: Date,
): { snap: QuotaSnapshot; raised: Record<string, string> } {
  const minutes = new Map(
    snap.providers.flatMap((p) => p.windows.map((w) => [`${p.provider}/${w.id}`, w.windowMinutes])),
  );
  const kept = Object.fromEntries(
    Object.entries(raised).filter(([, at]) => Date.parse(at) > now.getTime()),
  );
  const alerts = snap.alerts.map((a) => {
    const key = alertKey(a);
    const before = kept[key];
    const length = minutes.get(`${a.provider}/${a.window}`);
    const tolerance = Math.max((length ?? 0) * 30_000, 300_000);
    kept[key] = a.resetsAt;
    const same =
      before !== undefined && Math.abs(Date.parse(before) - Date.parse(a.resetsAt)) < tolerance;
    return same ? a : { ...a, notify: true as const };
  });
  return { snap: { ...snap, alerts }, raised: kept };
}

/**
 * Gives a provider CodexBar failed for its last windows read without an error whose reset has not
 * passed, marked with when they were read, so a failed round keeps them on screen as stale
 * instead of dropping them.
 * Returns the providers and the last windows to keep.
 */
export function keepLast(
  providers: ProviderQuota[],
  last: Record<string, LastQuota>,
  now: Date,
): { providers: ProviderQuota[]; last: Record<string, LastQuota> } {
  const kept = { ...last };
  const out = providers.map((p) => {
    if (!p.error) {
      if (p.windows.length > 0)
        kept[p.provider] = {
          at: iso(now),
          ...(p.account ? { account: p.account } : {}),
          windows: p.windows,
        };
      return p;
    }
    const before = kept[p.provider];
    if (p.windows.length > 0 || !before) return p;
    // A window whose reset passed says nothing about the one running now.
    const windows = before.windows.filter(
      (w) => !w.resetsAt || Date.parse(w.resetsAt) > now.getTime(),
    );
    if (windows.length === 0) {
      delete kept[p.provider];
      return p;
    }
    return {
      ...p,
      ...(before.account && !p.account ? { account: before.account } : {}),
      windows,
      updatedAt: before.at,
    };
  });
  return { providers: out, last: kept };
}

function describe(p: ProviderQuota): string[] {
  if (p.windows.length === 0) return [`${p.provider}: ${p.error ?? "no windows"}`];
  const stale = p.updatedAt ? [`${p.provider}: ${p.error}; windows from ${p.updatedAt}`] : [];
  return stale.concat(
    p.windows.map((w) => {
      const pace = w.pace ? ` ${w.pace.stage}` : "";
      const reset = w.resetsAt ? `, resets ${w.resetsAt}` : "";
      return `${p.provider} ${w.label}: ${Math.round(w.usedPercent)}% used${reset}${pace}`;
    }),
  );
}

/** One snapshot: run CodexBar, compute pace and alerts, seal to every device, post. */
export async function pushOnce(ctx: Ctx, opts: QuotaOpts): Promise<QuotaSnapshot> {
  const s = session(ctx);
  const bin = opts.codexbar ?? ctx.env.STARBRIDGE_CODEXBAR ?? "codexbar";
  const collected = await collect(bin, opts.providers, ctx.now, ctx.err);
  const dir = await refreshDirectory(ctx, s);
  const to = devices(dir);
  const now = ctx.now();
  const { providers, last } = keepLast(collected, ctx.store.state().quotas ?? {}, now);
  const { snap, raised } = raise(
    snapshot(
      providers,
      to.map((d) => d.id),
      now,
    ),
    ctx.store.state().alerts ?? {},
    now,
  );
  const item = seal("quota", snap, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to);
  // Only a snapshot that raises an alert asks for a push.
  await s.api.postItem(snap.alerts.some((a) => a.notify) ? item : { ...item, quiet: true });
  // Recorded once posted, so a failed post raises its alerts again next round.
  ctx.store.updateState((st) => {
    st.alerts = raised;
    st.quotas = last;
  });
  return snap;
}

/**
 * `quota push`: one snapshot every interval (default 5 minutes), or one with `--once`. A failed
 * round is logged and the loop goes on; `--once` exits 1 when the post failed.
 */
export async function quotaPush(
  ctx: Ctx,
  opts: QuotaOpts,
  push: () => Promise<QuotaSnapshot> = () => pushOnce(ctx, opts),
): Promise<number> {
  const interval = parseDuration(opts.interval ?? "5m");
  while (true) {
    const started = ctx.now().getTime();
    try {
      const snap = await push();
      const windows = snap.providers.reduce((n, p) => n + p.windows.length, 0);
      const line = `posted ${snap.id}: ${snap.providers.length} providers, ${windows} windows, ${snap.alerts.length} alerts`;
      if (opts.once) {
        for (const p of snap.providers) for (const l of describe(p)) ctx.out(l);
        for (const a of snap.alerts)
          ctx.out(`alert: ${a.kind} ${a.provider} ${a.window}${a.notify ? " (new)" : ""}`);
        ctx.out(line);
        return 0;
      }
      ctx.err(`${iso(ctx.now())} ${line}`);
    } catch (e) {
      ctx.err(`${iso(ctx.now())} starbridge: ${(e as Error).message}`);
      if (opts.once) return 1;
    }
    if (ctx.signal?.aborted) return 0;
    await ctx.sleep(Math.max(0, started + interval - ctx.now().getTime()));
    if (ctx.signal?.aborted) return 0;
  }
}
