// Quotas: each machine's latest snapshot of its AI plans' usage windows, read from CodexBar.
import { activeMembers, type openAsync } from "@starbridge/protocol";
import { api } from "../api";
import type { QuotaCardData } from "../types";
import { type Ctx, hold, openMachine } from "./core";

export interface Quotas {
  cards: QuotaCardData[];
  takenAt?: string;
  /** Providers CodexBar failed for with no windows to keep (#450). */
  errors: { provider: string; machine?: string; error: string }[];
  rejected: { id: string; error: string }[];
}

export async function loadQuotas(ctx: Ctx): Promise<Quotas> {
  const out: Quotas = { cards: [], errors: [], rejected: [] };
  const stored = await api.quota();
  const machines = activeMembers(ctx.dir, "machine").length;
  for (const s of stored) {
    let opened: Awaited<ReturnType<typeof openAsync<"quota">>>;
    try {
      opened = await openMachine(ctx, s.item, "quota");
    } catch (e) {
      out.rejected.push({ id: s.item.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const { signer: machine, body } = opened;
    if (!out.takenAt || body.takenAt > out.takenAt) out.takenAt = body.takenAt;
    for (const p of body.providers) {
      // A failure with windows is said on their group; one with nothing to show, on a group of
      // its own.
      if (p.error && p.windows.length === 0)
        out.errors.push({
          provider: p.provider,
          ...(machines > 1 ? { machine: machine.name } : {}),
          error: p.error,
        });
      const stale = p.error
        ? { updatedAt: p.updatedAt ?? body.takenAt, error: p.error }
        : undefined;
      for (const w of p.windows) {
        const alerts = body.alerts.filter((a) => a.provider === p.provider && a.window === w.id);
        // The card's state follows the pace alert; "low" only notifies.
        const alert = alerts.find((a) => a.kind !== "low");
        out.cards.push({
          provider: p.provider,
          ...(machines > 1 ? { machine: machine.name } : {}),
          window: w,
          ...(alert ? { alert } : {}),
          alerts,
          snapshot: body.id,
          ...(stale ? { stale } : {}),
        });
      }
    }
  }
  await hold(ctx);
  return out;
}
