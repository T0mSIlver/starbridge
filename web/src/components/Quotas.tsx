"use client";

import Link from "next/link";
import { useEffect } from "react";
import { relative } from "@/lib/format";
import { arrange } from "@/lib/quotaSettings";
import { useApp } from "./AppProvider";
import { useNow } from "./Feed";
import { PhoneBar } from "./PhoneBar";
import { QuotaRow } from "./QuotaRow";
import s from "./Quotas.module.css";

export function Quotas() {
  const { quotas, refreshQuotas, quotaSettings: settings } = useApp();
  useEffect(() => {
    refreshQuotas().catch(() => {});
  }, [refreshQuotas]);
  const now = new Date(useNow(true, 60_000));
  const cards = arrange(quotas?.cards ?? [], settings, now);
  return (
    <>
      <PhoneBar title="Quotas" find={false} />
      <div className={s.page}>
        <header className={s.head}>
          <h1 className={`t-heading ${s.title}`}>Quotas</h1>
          {quotas?.takenAt && (
            <span className={`t-caption ${s.dim}`}>Updated {relative(quotas.takenAt, now)}</span>
          )}
        </header>
        {quotas?.rejected.length ? (
          <p className={`t-meta ${s.bad}`} role="status">
            A snapshot failed verification and is hidden: {quotas.rejected[0]?.error}
          </p>
        ) : null}
        {quotas?.errors.map((e) => (
          <p key={`${e.machine}/${e.provider}`} className={`t-meta ${s.dim}`}>
            {e.provider} on {e.machine}: {e.error}
          </p>
        ))}
        {quotas === undefined ? null : cards.length === 0 && quotas.cards.length > 0 ? (
          <p className={`t-small ${s.empty}`}>
            Every provider is hidden. <Link href="/settings">Settings</Link>
          </p>
        ) : cards.length === 0 ? (
          <p className={`t-small ${s.empty}`}>
            No quota windows yet: run <code className="t-snippet">starbridge setup</code> on a
            machine with CodexBar.
          </p>
        ) : (
          <div className={s.rows}>
            {cards.map((q) => (
              <QuotaRow
                key={`${q.machine ?? ""}/${q.provider}/${q.window.id}`}
                q={q}
                settings={settings}
                now={now}
                comfy
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
