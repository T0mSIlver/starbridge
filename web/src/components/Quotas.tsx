"use client";

import Link from "next/link";
import { useEffect } from "react";
import { relative } from "@/lib/format";
import {
  arrange,
  type QuotaGroup as Group,
  groups,
  providerOrder,
  type QuotaSettings,
  reorder,
  runningOut,
} from "@/lib/quotaSettings";
import type { QuotaCardData } from "@/lib/types";
import { useApp } from "./AppProvider";
import { useNow } from "./Feed";
import { Icon } from "./icons";
import { PhoneBar } from "./PhoneBar";
import { QuotaGroup } from "./QuotaRow";
import s from "./Quotas.module.css";
import { useReorder } from "./Reorder";

export function Quotas() {
  const { quotas, refreshQuotas, quotaSettings: settings, setQuotaSettings } = useApp();
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
          <Groups
            all={quotas.cards}
            cards={cards}
            settings={settings}
            now={now}
            setOrder={(order) => setQuotaSettings({ ...settings, order })}
          />
        )}
      </div>
    </>
  );
}

const key = (g: Group) => `${g.provider}/${g.machine ?? ""}`;

/**
 * One table from 900 px, a card per provider below it. On the table, a provider's handle drags it
 * to a new place, live (Reorder.tsx); providers that lead while "Running out first" is on stay
 * put. Narrow screens reorder in Settings.
 */
function Groups({
  all,
  cards,
  settings,
  now,
  setOrder,
}: {
  all: QuotaCardData[];
  cards: QuotaCardData[];
  settings: QuotaSettings;
  now: Date;
  setOrder: (order: string[]) => void;
}) {
  const list = groups(cards);
  const ids = list.map(key);
  const leads = (g: Group) =>
    settings.runningOutFirst && !!g.cards[0] && runningOut(g.cards[0].window, now);
  const first = list.filter(leads).length;
  const reorderer = useReorder({
    ids,
    first,
    name: (id) => id.replace(/\/$/, "").replace("/", " on "),
    onMove: (id, to) => {
      const moved = list.filter((g) => key(g) !== id);
      const g = list.find((x) => key(x) === id);
      if (!g) return;
      moved.splice(to, 0, g);
      const sequence = [...new Set(moved.slice(first).map((x) => x.provider))];
      setOrder(reorder(providerOrder(all, settings), sequence));
    },
  });
  return (
    <div className={`${s.rows} ${reorderer.list.className ?? ""}`}>
      {list.map((g) => {
        const item = reorderer.item(key(g));
        return (
          <div key={key(g)} ref={item.ref} style={item.style} className={item.className}>
            <QuotaGroup
              g={g}
              settings={settings}
              now={now}
              comfy
              handle={
                <button type="button" {...reorderer.handle(key(g))}>
                  <Icon name="drag" size={18} />
                </button>
              }
            />
          </div>
        );
      })}
      <p className="sr-only" aria-live="polite">
        {reorderer.said}
      </p>
    </div>
  );
}
