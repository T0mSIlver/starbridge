"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { providerOrder, type QuotaSettings, type Ticks } from "@/lib/quotaSettings";
import { useApp } from "./AppProvider";
import s from "./QuotaSettings.module.css";
import ui from "./ui.module.css";

function Choice<T extends string | number | boolean | null>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className={s.row} disabled={disabled}>
      <legend className="t-body">{label}</legend>
      <div className={s.choice}>
        {options.map(([v, text]) => (
          <label key={String(v)} className={s.option}>
            <input type="radio" checked={v === value} onChange={() => onChange(v)} />
            <span>{text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={s.toggle}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

const toggle = (list: string[], p: string, on: boolean) =>
  on ? [...new Set([...list, p])] : list.filter((x) => x !== p);

export function QuotaSettingsForm() {
  const { quotas, refreshQuotas, quotaSettings: q, setQuotaSettings: set } = useApp();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">();
  useEffect(() => {
    refreshQuotas().catch(() => {});
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, [refreshQuotas]);
  const patch = (p: Partial<QuotaSettings>) => set({ ...q, ...p });
  const providers = providerOrder(quotas?.cards ?? [], q);
  const move = (i: number, by: number) => {
    const order = [...providers];
    const [p] = order.splice(i, 1);
    order.splice(i + by, 0, p as string);
    patch({ order });
  };
  const notify = async (p: string, on: boolean) => {
    if (on && permission === "default") setPermission(await Notification.requestPermission());
    patch({ notify: toggle(q.notify, p, on) });
  };

  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Quota settings</h1>
        <Link href="/quotas" className="t-small">
          Back to quotas
        </Link>
      </header>
      <p className="t-small">These stay in this browser.</p>

      <h2 className={`t-label ${ui.section}`}>Bars</h2>
      <div className={`${ui.card} ${s.group}`}>
        <Choice<boolean>
          label="Bars show"
          value={q.showUsed}
          options={[
            [true, "Used"],
            [false, "Remaining"],
          ]}
          onChange={(showUsed) => patch({ showUsed })}
        />
        <Choice<boolean>
          label="Reset times"
          value={q.absoluteResets}
          options={[
            [false, "In 2 h"],
            [true, "Clock time"],
          ]}
          onChange={(absoluteResets) => patch({ absoluteResets })}
        />
        <Choice<4 | 5 | 7 | null>
          label="Workdays on weekly bars"
          value={q.workDays}
          options={[
            [null, "Off"],
            [4, "4 days"],
            [5, "5 days"],
            [7, "7 days"],
          ]}
          onChange={(workDays) => patch({ workDays })}
        />
        <p className={`t-small ${s.hint}`}>
          Ticks mark each workday from Monday, and the pace marker counts workdays only.
        </p>
        <Choice<Ticks>
          label="Workday ticks"
          value={q.ticks}
          disabled={q.workDays === null}
          options={[
            ["subtle", "Subtle"],
            ["high-contrast", "High contrast"],
            ["hidden", "Hidden"],
          ]}
          onChange={(ticks) => patch({ ticks })}
        />
      </div>

      <h2 className={`t-label ${ui.section}`}>Providers</h2>
      {providers.length === 0 ? (
        <p className={ui.empty}>No provider has sent a quota yet.</p>
      ) : (
        <ul className={`${ui.card} ${s.group}`}>
          {providers.map((p, i) => (
            <li key={p} className={s.provider}>
              <span className={`t-action ${s.name}`}>{p}</span>
              <Toggle
                label="Show"
                checked={!q.hidden.includes(p)}
                onChange={(on) => patch({ hidden: toggle(q.hidden, p, !on) })}
              />
              <Toggle
                label="Notify"
                checked={q.notify.includes(p)}
                onChange={(on) => notify(p, on)}
              />
              <span className={s.move}>
                <button
                  type="button"
                  className={ui.button}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${p} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={ui.button}
                  disabled={i === providers.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${p} down`}
                >
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className={`t-label ${ui.section}`}>Notify about</h2>
      <div className={`${ui.card} ${s.group}`}>
        <Toggle
          label="50% and 20% left"
          checked={q.notifyLow}
          onChange={(notifyLow) => patch({ notifyLow })}
        />
        <Toggle
          label="Will run out, or resets with headroom unused"
          checked={q.notifyPace}
          onChange={(notifyPace) => patch({ notifyPace })}
        />
        <p className={`t-small ${s.hint}`}>
          Once per window per reset, for the providers set to notify, while a Starbridge page is
          open in this browser.
        </p>
        {permission === "denied" && q.notify.length > 0 && (
          <p className={ui.notice}>
            Notifications are blocked for this site in the browser&apos;s settings.
          </p>
        )}
      </div>
    </>
  );
}
