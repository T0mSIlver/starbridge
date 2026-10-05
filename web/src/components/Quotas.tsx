"use client";

import Link from "next/link";
import { useEffect } from "react";
import { relative } from "@/lib/format";
import { arrange, type QuotaSettings } from "@/lib/quotaSettings";
import { useApp } from "./AppProvider";
import { QuotaCard } from "./QuotaCard";
import ui from "./ui.module.css";

/** Turns on one provider's notifications, asking the browser's permission first. */
export async function notifyProvider(
  provider: string,
  s: QuotaSettings,
  set: (s: QuotaSettings) => void,
): Promise<void> {
  if (typeof Notification !== "undefined" && Notification.permission === "default")
    await Notification.requestPermission();
  set({ ...s, notify: [...new Set([...s.notify, provider])] });
}

export function Quotas({ gridClass }: { gridClass: string }) {
  const { quotas, refreshQuotas, quotaSettings: settings, setQuotaSettings } = useApp();
  useEffect(() => {
    refreshQuotas().catch(() => {});
  }, [refreshQuotas]);

  const cards = arrange(quotas?.cards ?? [], settings);
  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Quotas</h1>
        <span className="t-small">
          {quotas?.takenAt && <>Updated {relative(quotas.takenAt)} · </>}
          <Link href="/quotas/settings">Settings</Link>
        </span>
      </header>
      {quotas?.rejected.length ? (
        <p className={ui.error} role="status">
          A snapshot failed verification and is hidden: {quotas.rejected[0]?.error}
        </p>
      ) : null}
      {quotas?.errors.map((e) => (
        <p key={`${e.machine}/${e.provider}`} className={ui.notice}>
          {e.provider} on {e.machine}: {e.error}
        </p>
      ))}
      {quotas === undefined ? (
        <p className={ui.empty}>Loading…</p>
      ) : cards.length === 0 && quotas.cards.length > 0 ? (
        <p className={ui.empty}>
          Every provider is hidden. <Link href="/quotas/settings">Show them in Settings</Link>.
        </p>
      ) : cards.length === 0 ? (
        <p className={ui.empty}>
          No quota snapshot yet. Run <code className="t-code">starbridge quota push</code> on a
          paired machine.
        </p>
      ) : (
        <ul className={`${ui.list} ${gridClass}`}>
          {cards.map((q) => (
            <li key={`${q.machine ?? ""}/${q.provider}/${q.window.id}`}>
              <QuotaCard
                q={q}
                settings={settings}
                onNotify={
                  settings.notify.includes(q.provider)
                    ? undefined
                    : () => notifyProvider(q.provider, settings, setQuotaSettings)
                }
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
