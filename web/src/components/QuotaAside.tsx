"use client";

import { useEffect } from "react";
import { relative } from "@/lib/format";
import { runningOutFirst } from "@/lib/quota";
import { arrange } from "@/lib/quotaSettings";
import { useApp } from "./AppProvider";
import { useNow } from "./Feed";
import s from "./QuotaAside.module.css";
import { QuotaRow } from "./QuotaRow";

/** The quota windows beside the inbox on the widest screens. */
export function QuotaAside() {
  const { quotas, refreshQuotas, quotaSettings: settings } = useApp();
  useEffect(() => {
    refreshQuotas().catch(() => {});
  }, [refreshQuotas]);
  const now = new Date(useNow(true, 60_000));
  const cards = runningOutFirst(arrange(quotas?.cards ?? [], settings), settings, now);
  return (
    <aside className={s.aside} aria-label="Quota windows">
      <header className={s.head}>
        <span className="t-label">Quota windows</span>
        {quotas?.takenAt && (
          <span className={`t-caption ${s.updated}`}>updated {relative(quotas.takenAt, now)}</span>
        )}
      </header>
      {cards.map((q) => (
        <QuotaRow
          key={`${q.machine ?? ""}/${q.provider}/${q.window.id}`}
          q={q}
          settings={settings}
          now={now}
        />
      ))}
    </aside>
  );
}
