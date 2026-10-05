"use client";

import { useEffect } from "react";
import { relative } from "@/lib/format";
import { arrange, groups } from "@/lib/quotaSettings";
import { useApp } from "./AppProvider";
import { useNow } from "./Feed";
import s from "./QuotaAside.module.css";
import { QuotaGroup } from "./QuotaRow";

/** The quota windows beside the inbox on the widest screens. */
export function QuotaAside() {
  const { quotas, refreshQuotas, quotaSettings: settings } = useApp();
  useEffect(() => {
    refreshQuotas().catch(() => {});
  }, [refreshQuotas]);
  const now = new Date(useNow(true, 60_000));
  const cards = arrange(quotas?.cards ?? [], settings, now);
  return (
    <aside className={s.aside} aria-label="Quota windows">
      <header className={s.head}>
        <span className="t-label">Quota windows</span>
        {quotas?.takenAt && (
          <span className={`t-caption ${s.updated}`}>updated {relative(quotas.takenAt, now)}</span>
        )}
      </header>
      {groups(cards).map((g) => (
        <QuotaGroup key={`${g.provider}/${g.machine ?? ""}`} g={g} settings={settings} now={now} />
      ))}
    </aside>
  );
}
