"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AGENTS_GUIDE } from "@/lib/links";
import { applyTheme, type Prefs, usePref } from "@/lib/prefs";
import { providerOrder, type QuotaSettings } from "@/lib/quotaSettings";
import type { Device } from "@/lib/types";
import { useApp } from "./AppProvider";
import { Icon } from "./icons";
import { PhoneBar } from "./PhoneBar";
import s from "./Settings.module.css";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={s.section} aria-label={title}>
      <h2 className="t-action">{title}</h2>
      <div className={s.box}>{children}</div>
    </section>
  );
}

export function Row({
  label,
  sub,
  children,
  muted,
}: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className={`${s.row} ${muted ? s.muted : ""}`}>
      <div className={s.rowText}>
        <div className="t-small">{label}</div>
        {sub && <div className={`t-meta ${s.sub}`}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

/** Choices side by side, one picked: a radio group drawn as joined buttons. */
export function Segmented<T extends string | number | boolean | null>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className={s.segmented} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <label key={String(v)} className={`t-meta ${s.segment}`}>
          <input
            type="radio"
            className="sr-only"
            checked={v === value}
            onChange={() => onChange(v)}
          />
          {text}
        </label>
      ))}
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-checked={checked}
      className={s.switch}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

const toggle = (list: string[], p: string, on: boolean) =>
  on ? [...new Set([...list, p])] : list.filter((x) => x !== p);

function InboxSection() {
  const [rowAnswers, setRowAnswers] = usePref("rowAnswers");
  return (
    <Section title="Inbox">
      <Row label="Answer buttons on questions" sub="On a phone">
        <Segmented<Prefs["rowAnswers"]>
          label="Answer buttons on questions"
          value={rowAnswers}
          options={[
            ["always", "Always"],
            ["waiting", "When the agent waits"],
            ["never", "Never"],
          ]}
          onChange={setRowAnswers}
        />
      </Row>
    </Section>
  );
}

function QuotaSection() {
  const { quotaSettings: q, setQuotaSettings: set } = useApp();
  const patch = (p: Partial<QuotaSettings>) => set({ ...q, ...p });
  return (
    <Section title="Quotas">
      <Row label="Bar shows">
        <Segmented<boolean>
          label="Bar shows"
          value={q.showUsed}
          options={[
            [true, "Used"],
            [false, "Left"],
          ]}
          onChange={(showUsed) => patch({ showUsed })}
        />
      </Row>
      <Row label="Reset times">
        <Segmented<boolean>
          label="Reset times"
          value={q.absoluteResets}
          options={[
            [false, "Resets in 2 h"],
            [true, "Resets 14:20"],
          ]}
          onChange={(absoluteResets) => patch({ absoluteResets })}
        />
      </Row>
      <Row label="Workday ticks on weekly bars">
        <Segmented<4 | 5 | 7 | null>
          label="Workday ticks on weekly bars"
          value={q.workDays}
          options={[
            [null, "Off"],
            [4, "4"],
            [5, "5"],
            [7, "7"],
          ]}
          onChange={(workDays) => patch({ workDays })}
        />
      </Row>
      {q.workDays !== null && (
        <Row label="Tick style">
          <Segmented<QuotaSettings["ticks"]>
            label="Tick style"
            value={q.ticks}
            options={[
              ["subtle", "Subtle"],
              ["high-contrast", "High contrast"],
              ["hidden", "Hidden"],
            ]}
            onChange={(ticks) => patch({ ticks })}
          />
        </Row>
      )}
      <Row label="Running out first">
        <Switch
          label="Running out first"
          checked={q.runningOutFirst}
          onChange={(runningOutFirst) => patch({ runningOutFirst })}
        />
      </Row>
      <Row label="Warn when a window runs low">
        <Switch
          label="Warn when a window runs low"
          checked={q.notifyLow}
          onChange={(notifyLow) => patch({ notifyLow })}
        />
      </Row>
      <Row label="Warn before a window runs out">
        <Switch
          label="Warn before a window runs out"
          checked={q.notifyPace}
          onChange={(notifyPace) => patch({ notifyPace })}
        />
      </Row>
    </Section>
  );
}

/** Each provider: drag (or arrow keys on the handle) to reorder, notify, show. */
function ProviderSection() {
  const { quotas, refreshQuotas, quotaSettings: q, setQuotaSettings: set } = useApp();
  const [dragging, setDragging] = useState<string>();
  useEffect(() => {
    refreshQuotas().catch(() => {});
  }, [refreshQuotas]);
  const cards = quotas?.cards ?? [];
  const providers = providerOrder(cards, q);
  if (providers.length === 0) return null;
  const patch = (p: Partial<QuotaSettings>) => set({ ...q, ...p });
  const moveTo = (p: string, at: number) => {
    const order = providers.filter((x) => x !== p);
    order.splice(Math.max(0, Math.min(at, order.length)), 0, p);
    patch({ order });
  };
  const notify = async (p: string, on: boolean) => {
    if (on && typeof Notification !== "undefined" && Notification.permission === "default")
      await Notification.requestPermission();
    patch({ notify: toggle(q.notify, p, on) });
  };
  return (
    <Section title="Providers">
      {providers.map((p, i) => {
        const shown = !q.hidden.includes(p);
        const windows = [
          ...new Set(cards.filter((c) => c.provider === p).map((c) => c.window.label)),
        ];
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: the handle is the keyboard path
          <div
            key={p}
            className={`${s.provider} ${dragging === p ? s.dragging : ""}`}
            onDragOver={(e) => dragging && e.preventDefault()}
            onDrop={() => dragging && moveTo(dragging, i)}
          >
            <button
              type="button"
              className={s.handle}
              draggable
              aria-label={`Move ${p}`}
              aria-keyshortcuts="ArrowUp ArrowDown"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                // Firefox starts a drag only with data set.
                e.dataTransfer.setData("text/plain", p);
                setDragging(p);
              }}
              onDragEnd={() => setDragging(undefined)}
              onKeyDown={(e) => {
                const by = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
                if (!by) return;
                e.preventDefault();
                moveTo(p, i + by);
              }}
            >
              <Icon name="drag" size={18} />
            </button>
            <span className={`t-small ${s.providerName} ${shown ? "" : s.dim}`}>
              {p} <span className={s.sub}>{windows.join(", ")}</span>
            </span>
            <span className={`t-meta ${s.notify} ${shown ? "" : s.dim}`}>
              Notify
              <Switch
                label={`Notify about ${p}`}
                checked={q.notify.includes(p)}
                disabled={!shown}
                onChange={(on) => notify(p, on)}
              />
            </span>
            <Switch
              label={`Show ${p}`}
              checked={shown}
              onChange={(on) => patch({ hidden: toggle(q.hidden, p, !on) })}
            />
          </div>
        );
      })}
    </Section>
  );
}

const added = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function DeviceSection() {
  const { update, boot, sampleDevices } = useApp();
  const ctx = boot.state === "ready" ? boot.ctx : undefined;
  const [all, setAll] = useState<Device[]>(sampleDevices ?? []);
  const [revoking, setRevoking] = useState<Device>();
  useEffect(() => {
    if (ctx) load().then((d) => setAll(d.devices(ctx)));
  }, [ctx]);
  const order = (d: Device) => (d.self ? 0 : d.role === "device" ? 1 : 2);
  const shown = all
    .filter((d) => d.status === "active")
    .sort((a, b) => order(a) - order(b) || a.addedAt.localeCompare(b.addedAt));
  return (
    <Section title="Devices">
      {shown.map((d) => (
        <div key={d.id} className={s.device}>
          <span className={s.deviceIcon}>
            <Icon name={d.role === "machine" ? "desktop" : "devices"} size={18} />
          </span>
          <div className={s.rowText}>
            <div className="t-small">{d.name}</div>
            <div className={`t-meta ${s.sub}`}>
              {d.role === "machine" ? "Machine" : "Device"}
              {d.self ? " · this browser" : d.addedAt ? ` · added ${added(d.addedAt)}` : ""}
            </div>
          </div>
          {d.self ? (
            <span className={s.revokeSpace} />
          ) : (
            <button
              type="button"
              className={`t-meta ${ui.btn} ${ui.sm} ${ui.ghost}`}
              onClick={() => setRevoking(d)}
            >
              Revoke
            </button>
          )}
        </div>
      ))}
      <div className={s.foot}>
        <Link href="/settings/devices/add" className={`t-meta ${ui.btn} ${ui.sm}`}>
          Add a device
        </Link>
      </div>
      {revoking && (
        <RevokeDialog
          device={revoking}
          onClose={() => setRevoking(undefined)}
          onRevoke={async () => {
            if (!ctx) return;
            if (!ctx) return;
            update(await (await load()).revoke(ctx, revoking.id));
            setRevoking(undefined);
          }}
        />
      )}
    </Section>
  );
}

/** Revoke stays neutral on the row; only this dialog's confirm button is red (DESIGN.md). */
function RevokeDialog({
  device,
  onClose,
  onRevoke,
}: {
  device: Device;
  onClose: () => void;
  onRevoke: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} className={s.dialog} onClose={onClose} aria-labelledby="revoke-title">
      <h3 id="revoke-title" className="t-subtitle">
        Revoke {device.name}?
      </h3>
      <p className={`t-small ${s.sub}`}>
        It can no longer read or answer anything. This can&apos;t be undone.
      </p>
      {error && <p className={`t-meta ${s.error}`}>{error}</p>}
      <div className={s.dialogActions}>
        <button type="button" className={`t-label ${ui.btn}`} onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className={`t-label ${ui.btn} ${ui.destroy}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await onRevoke();
            } catch (e) {
              setError(message(e));
              setBusy(false);
            }
          }}
        >
          Revoke
        </button>
      </div>
    </dialog>
  );
}

function ClockSection() {
  const [clock, setClock] = usePref("clock");
  return (
    <Section title="Clock">
      <Row label="Time format">
        <Segmented<Prefs["clock"]>
          label="Time format"
          value={clock}
          options={[
            ["system", "System"],
            ["12", "12-hour"],
            ["24", "24-hour"],
          ]}
          onChange={setClock}
        />
      </Row>
    </Section>
  );
}

function ColourSection() {
  const [theme, setTheme] = usePref("theme");
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <Section title="Colours">
      <Row label="Theme">
        <Segmented<Prefs["theme"]>
          label="Theme"
          value={theme}
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          onChange={setTheme}
        />
      </Row>
    </Section>
  );
}

export function Settings() {
  return (
    <>
      <PhoneBar title="Settings" find={false} />
      <div className={s.page}>
        <h1 className={`t-heading ${s.title}`}>Settings</h1>
        <InboxSection />
        <QuotaSection />
        <ProviderSection />
        <DeviceSection />
        <ColourSection />
        <ClockSection />
        <Section title="Agents">
          <a className={s.linkRow} href={AGENTS_GUIDE} target="_blank" rel="noopener noreferrer">
            <span className="t-small">How to tell your agents</span>
            <Icon name="open" size={16} />
          </a>
        </Section>
      </div>
    </>
  );
}
