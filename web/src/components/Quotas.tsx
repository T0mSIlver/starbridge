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

/** What one handle drags: a leading group alone, or a provider with its groups from every machine. */
type Unit = { id: string; provider: string; groups: Group[] };

/**
 * One table from 900 px, a card per provider below it. On the table, a provider's handle drags it
 * to a new place, live (Reorder.tsx), with its rows from every machine, which `arrange` keeps
 * together. Providers that lead while "Running out first" is on stay put, and so does a provider
 * with a leading row, since its place in the order is theirs. Narrow screens reorder in Settings.
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
  const leads = (g: Group) =>
    settings.runningOutFirst && !!g.cards[0] && runningOut(g.cards[0].window, now);
  const first = list.filter(leads).length;
  const leading = new Set(list.slice(0, first).map((g) => g.provider));
  const units: Unit[] = list.slice(0, first).map((g) => ({
    id: `lead/${key(g)}`,
    provider: g.provider,
    groups: [g],
  }));
  for (const g of list.slice(first)) {
    const last = units.at(-1);
    if (units.length > first && last?.provider === g.provider) last.groups.push(g);
    else units.push({ id: g.provider, provider: g.provider, groups: [g] });
  }
  const reorderer = useReorder({
    ids: units.map((u) => u.id),
    first,
    locked: (id) => leading.has(id),
    name: (id) => id,
    onMove: (id, to) => {
      const moved = units.filter((u) => u.id !== id);
      const u = units.find((x) => x.id === id);
      if (!u) return;
      moved.splice(to, 0, u);
      const sequence = moved
        .slice(first)
        .map((x) => x.provider)
        .filter((p) => !leading.has(p));
      setOrder(reorder(providerOrder(all, settings), sequence));
    },
  });
  return (
    <div className={`${s.rows} ${reorderer.list.className ?? ""}`}>
      {units.map((u) => {
        const item = reorderer.item(u.id);
        return (
          <div key={u.id} ref={item.ref} style={item.style} className={item.className}>
            {u.groups.map((g, i) => (
              <QuotaGroup
                key={key(g)}
                g={g}
                settings={settings}
                now={now}
                comfy
                handle={
                  i === 0 ? (
                    <button type="button" {...reorderer.handle(u.id)}>
                      <Icon name="drag" size={18} />
                    </button>
                  ) : (
                    <span className={s.handleSpace} />
                  )
                }
              />
            ))}
          </div>
        );
      })}
      <p className="sr-only" aria-live="polite">
        {reorderer.said}
      </p>
    </div>
  );
}
