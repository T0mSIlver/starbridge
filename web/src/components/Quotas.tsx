"use client";

import { useEffect } from "react";
import { relative } from "@/lib/format";
import { useApp } from "./AppProvider";
import { QuotaCard } from "./QuotaCard";
import ui from "./ui.module.css";

const POLL_MS = 60_000;

// Windows with an alert first, then the order the uploader sent.
export function Quotas({ gridClass }: { gridClass: string }) {
  const { quotas, refreshQuotas } = useApp();
  useEffect(() => {
    refreshQuotas().catch(() => {});
    const timer = setInterval(() => refreshQuotas().catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshQuotas]);

  const sorted = [...(quotas?.cards ?? [])].sort((a, b) => Number(!!b.alert) - Number(!!a.alert));
  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Quotas</h1>
        {quotas?.takenAt && <span className="t-small">Updated {relative(quotas.takenAt)}</span>}
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
      ) : sorted.length === 0 ? (
        <p className={ui.empty}>
          No quota snapshot yet. Run <code className="t-code">starbridge quota push</code> on a
          paired machine.
        </p>
      ) : (
        <ul className={`${ui.list} ${gridClass}`}>
          {sorted.map((q) => (
            <li key={`${q.machine ?? ""}/${q.provider}/${q.window.id}`}>
              <QuotaCard q={q} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
