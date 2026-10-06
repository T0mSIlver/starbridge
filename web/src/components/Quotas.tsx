"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { relative } from "@/lib/format";
import {
  arrange,
  type QuotaGroup as Group,
  groups,
  providerOrder,
  type QuotaSettings,
  reorder,
  runningOut,
  runsOutSoonest,
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
  const { quotas, refreshQuotas, askQuotas, quotaSettings: settings, setQuotaSettings } = useApp();
  useEffect(() => {
    refreshQuotas().catch(() => {});
  }, [refreshQuotas]);
  const now = new Date(useNow(true, 60_000));
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    if (busy) return;
    setBusy(true);
    askQuotas()
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const cards = arrange(quotas?.cards ?? [], settings, now);
  // Providers with no windows to show come after the others, under their name with why.
  const failed: Group[] = (quotas?.errors ?? [])
    .filter((e) => !settings.hidden.includes(e.provider))
    .map((e) => ({
      provider: e.provider,
      machine: e.machine,
      cards: [],
      stale: { error: e.error },
    }));
  return (
    <>
      <PhoneBar
        title="Quotas"
        find={false}
        view={<Refresh busy={busy} run={refresh} size={22} />}
      />
      <div className={s.page}>
        <header className={s.head}>
          <h1 className={`t-heading ${s.title}`}>Quotas</h1>
          {quotas?.takenAt && (
            <span className={`t-caption ${s.dim}`}>Updated {relative(quotas.takenAt, now)}</span>
          )}
          <Refresh busy={busy} run={refresh} size={18} />
        </header>
        {quotas?.rejected.length ? (
          <p className={`t-meta ${s.bad}`} role="status">
            A snapshot failed verification and is hidden: {quotas.rejected[0]?.error}
          </p>
        ) : null}
        {quotas === undefined ? null : cards.length === 0 &&
          failed.length === 0 &&
          quotas.cards.length + quotas.errors.length > 0 ? (
          <p className={`t-small ${s.empty}`}>
            Every provider is hidden. <Link href="/settings">Settings</Link>
          </p>
        ) : cards.length === 0 && failed.length === 0 ? (
          <p className={`t-small ${s.empty}`}>
            No quota windows yet: run <code className="t-snippet">starbridge setup</code> on a
            machine with CodexBar.
          </p>
        ) : (
          <Groups
            all={quotas.cards}
            cards={cards}
            failed={failed}
            settings={settings}
            now={now}
            setOrder={(order) => setQuotaSettings({ ...settings, order })}
          />
        )}
      </div>
    </>
  );
}

/**
 * Asks every machine to read CodexBar again and loads what they post, as Android's pull to
 * refresh does; the icon turns until then, up to the 25 s the server holds the ask. The phone
 * bar's and the header's buttons share one `busy`, so either shows a refresh the other started.
 */
function Refresh({ busy, run, size }: { busy: boolean; run: () => void; size: number }) {
  return (
    <button
      type="button"
      className={`${s.refresh} ${busy ? s.busy : ""}`}
      aria-label="Refresh quotas"
      aria-busy={busy}
      onClick={run}
    >
      <Icon name="refresh" size={size} />
    </button>
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
  failed,
  settings,
  now,
  setOrder,
}: {
  all: QuotaCardData[];
  cards: QuotaCardData[];
  failed: Group[];
  settings: QuotaSettings;
  now: Date;
  setOrder: (order: string[]) => void;
}) {
  const list = groups(cards);
  const leads = (g: Group) =>
    settings.runningOutFirst && !!g.cards[0] && runningOut(g.cards[0].window, now);
  const first = list.filter(leads).length;
  const leading = new Set(list.slice(0, first).map((g) => g.provider));
  const soonest = runsOutSoonest(list.slice(0, first), now);
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
      {units.map((u, n) => {
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
                  i === 0 && n < first ? (
                    <Pinned provider={u.provider} soonest={u.groups[0] === soonest} />
                  ) : i === 0 ? (
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
      {failed.map((g) => (
        <QuotaGroup
          key={`failed/${key(g)}`}
          g={g}
          settings={settings}
          now={now}
          comfy
          handle={<span className={s.handleSpace} />}
        />
      ))}
      <p className="sr-only" aria-live="polite">
        {reorderer.said}
      </p>
    </div>
  );
}

/**
 * In a pinned group's handle slot, a pin whose tap or click says why the group leads: a popover
 * in the top layer, since the table's rows clip what overflows them, and not a `title`, which
 * phones never show (#285). It closes on Escape, a click outside, or a scroll.
 */
function Pinned({ provider, soonest }: { provider: string; soonest: boolean }) {
  const id = useId();
  const pin = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => pop.current?.hidePopover(), []);
  useEffect(() => () => removeEventListener("scroll", close, true), [close]);
  const toggled = (e: React.ToggleEvent<HTMLDivElement>) => {
    removeEventListener("scroll", close, true);
    const p = pop.current;
    const b = pin.current?.getBoundingClientRect();
    if (e.newState !== "open" || !p || !b) return;
    const edge = 16;
    p.style.top = `${b.bottom + 4}px`;
    p.style.left = `${Math.max(edge, Math.min(b.left, innerWidth - p.offsetWidth - edge))}px`;
    addEventListener("scroll", close, true);
  };
  return (
    <>
      <button
        type="button"
        ref={pin}
        className={s.pin}
        popoverTarget={id}
        aria-label={`Why ${provider} is up top`}
      >
        <Icon name="pin" size={18} />
      </button>
      <div id={id} ref={pop} popover="auto" className={`t-meta ${s.why}`} onToggle={toggled}>
        {soonest ? "Up top because it runs out soonest." : "Up top because it's running out."}{" "}
        Change in <Link href="/settings#running-out-first">Settings</Link>.
      </div>
    </>
  );
}
