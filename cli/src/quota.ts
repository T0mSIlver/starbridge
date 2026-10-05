import { randomBytes } from "node:crypto";
import { alertsFor, type QuotaSnapshot, seal } from "@starbridge/protocol";
import { collect, type ProviderQuota } from "./codexbar";
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
    alerts: providers.flatMap((p) => p.windows.flatMap((w) => alertsFor(p.provider, w, now))),
  };
}

function describe(p: ProviderQuota): string[] {
  if (p.windows.length === 0) return [`${p.provider}: ${p.error ?? "no windows"}`];
  return p.windows.map((w) => {
    const pace = w.pace ? ` ${w.pace.stage}` : "";
    const reset = w.resetsAt ? `, resets ${w.resetsAt}` : "";
    return `${p.provider} ${w.label}: ${Math.round(w.usedPercent)}% used${reset}${pace}`;
  });
}

/** One snapshot: run CodexBar, compute pace and alerts, seal to every device, post. */
export async function pushOnce(ctx: Ctx, opts: QuotaOpts): Promise<QuotaSnapshot> {
  const s = session(ctx);
  const bin = opts.codexbar ?? ctx.env.STARBRIDGE_CODEXBAR ?? "codexbar";
  const providers = await collect(bin, opts.providers, ctx.now, ctx.err);
  const dir = await refreshDirectory(ctx, s);
  const to = devices(dir);
  const snap = snapshot(
    providers,
    to.map((d) => d.id),
    ctx.now(),
  );
  const item = seal("quota", snap, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to);
  await s.api.postItem(item);
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
        for (const a of snap.alerts) ctx.out(`alert: ${a.kind} ${a.provider} ${a.window}`);
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
