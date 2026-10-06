"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { RecoveryState } from "@/lib/device";
import { addedLabels, dayAndTime } from "@/lib/format";
import { AGENTS_GUIDE } from "@/lib/links";
import { applyTheme, type Prefs, usePref } from "@/lib/prefs";
import { providerOrder, type QuotaSettings } from "@/lib/quotaSettings";
import { chime } from "@/lib/sound";
import type { Device, QuotaCardData } from "@/lib/types";
import { useApp } from "./AppProvider";
import { Icon } from "./icons";
import { PhoneBar } from "./PhoneBar";
import { useReorder } from "./Reorder";
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
  id,
  label,
  sub,
  children,
  muted,
}: {
  /** A target for links to this setting. */
  id?: string;
  label: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div id={id} className={`${s.row} ${muted ? s.muted : ""}`}>
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

/** Rows still loading: a skeleton in their shape, shown only if the wait passes 200 ms. */
function Pending({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={i} className={s.row} aria-hidden>
          <span className={`skeleton ${s.bone}`} />
        </div>
      ))}
    </>
  );
}

const toggle = (list: string[], p: string, on: boolean) =>
  on ? [...new Set([...list, p])] : list.filter((x) => x !== p);

function InboxSection() {
  const [rowAnswers, setRowAnswers] = usePref("rowAnswers");
  const [sound, setSound] = usePref("sound");
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
      <Row label="Sound for new questions" sub="While a Starbridge page is open">
        <Switch
          label="Sound for new questions"
          checked={sound}
          onChange={(on) => {
            setSound(on);
            if (on) chime();
          }}
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
      <Row id="running-out-first" label="Running out first">
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
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    refreshQuotas()
      .catch(() => {})
      .finally(() => setSettled(true));
  }, [refreshQuotas]);
  const cards = quotas?.cards ?? [];
  const providers = providerOrder(cards, q);
  if (providers.length === 0)
    return (
      <Section title="Providers">
        {quotas || settled ? <Row label="No quota windows yet" muted /> : <Pending rows={2} />}
      </Section>
    );
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
      <Providers
        providers={providers}
        cards={cards}
        q={q}
        moveTo={moveTo}
        notify={notify}
        patch={patch}
      />
    </Section>
  );
}

/** The provider rows, reordered live by their handles (Reorder.tsx). */
function Providers({
  providers,
  cards,
  q,
  moveTo,
  notify,
  patch,
}: {
  providers: string[];
  cards: QuotaCardData[];
  q: QuotaSettings;
  moveTo: (p: string, at: number) => void;
  notify: (p: string, on: boolean) => void;
  patch: (p: Partial<QuotaSettings>) => void;
}) {
  const reorder = useReorder({ ids: providers, name: (p) => p, onMove: moveTo });
  return (
    <div className={`${s.providers} ${reorder.list.className ?? ""}`}>
      {providers.map((p) => {
        const shown = !q.hidden.includes(p);
        const windows = [
          ...new Set(cards.filter((c) => c.provider === p).map((c) => c.window.label)),
        ];
        const item = reorder.item(p);
        return (
          <div
            key={p}
            ref={item.ref}
            style={item.style}
            className={`${s.provider} ${item.className}`}
          >
            <button type="button" {...reorder.handle(p)}>
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
      <p className="sr-only" aria-live="polite">
        {reorder.said}
      </p>
    </div>
  );
}

/**
 * A device's name with a break allowed after each dot, so a host name wraps between its labels,
 * as it does after a hyphen; `.rowText` breaks inside a word only when nothing else fits.
 */
function HostName({ name }: { name: string }) {
  const parts = name.split(/(?<=\.)/);
  return parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string.
    <span key={i}>
      {part}
      {i < parts.length - 1 && <wbr />}
    </span>
  ));
}

function DeviceSection() {
  const { update, boot, sampleDevices } = useApp();
  const ctx = boot.state === "ready" ? boot.ctx : undefined;
  const [all, setAll] = useState<Device[] | undefined>(sampleDevices);
  const [revoking, setRevoking] = useState<Device>();
  const [recovery, setRecovery] = useState<RecoveryState>();
  const [clock] = usePref("clock");
  useEffect(() => {
    if (ctx)
      load()
        .then(async (d) => {
          setAll(d.devices(ctx));
          setRecovery(await d.recoveryState(ctx));
        })
        .catch(() => setAll([]));
  }, [ctx]);
  const order = (d: Device) => (d.self ? 0 : d.role === "device" ? 1 : 2);
  const shown = (all ?? [])
    .filter((d) => d.status === "active")
    .sort((a, b) => order(a) - order(b) || a.addedAt.localeCompare(b.addedAt));
  const added = addedLabels(shown, clock);
  return (
    <Section title="Devices">
      {!all && <Pending rows={2} />}
      {shown.map((d) => (
        <div key={d.id} className={s.device}>
          <span className={s.deviceIcon}>
            <Icon name={d.role === "machine" ? "desktop" : "devices"} size={18} />
          </span>
          <div className={s.rowText}>
            <div className="t-small">
              <HostName name={d.name} />
            </div>
            <div className={`t-meta ${s.sub}`}>
              {d.role === "machine" ? "Machine" : "Device"}
              {d.self ? " · this browser" : d.addedAt ? ` · ${added.get(d.id)}` : ""}
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
      {recovery && (
        <div className={s.device}>
          <span className={s.deviceIcon}>
            <Icon name="key" size={18} />
          </span>
          <div className={s.rowText}>
            <div className="t-small">Recovery key</div>
            <div className={`t-meta ${s.sub}`}>
              {`${recovery.set.replaced ? "Replaced" : "Set"} ${dayAndTime(recovery.set.at, clock)} on ${recovery.set.by}`}
            </div>
          </div>
          <Link href="/settings/recovery-key" className={`t-meta ${ui.btn} ${ui.sm} ${ui.ghost}`}>
            Replace
          </Link>
        </div>
      )}
      <div className={s.foot}>
        <Link href="/settings/devices/add" className={`t-meta ${ui.btn} ${ui.sm}`}>
          Add a device
        </Link>
      </div>
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          text="It can no longer read or answer anything. This can't be undone."
          action="Revoke"
          onClose={() => setRevoking(undefined)}
          onConfirm={async () => {
            if (!ctx) return;
            update(await (await load()).revoke(ctx, revoking.id));
            setRevoking(undefined);
          }}
        />
      )}
    </Section>
  );
}

/** A destructive action's dialog: neutral on the row, only this confirm button is red (DESIGN.md). */
function ConfirmDialog({
  title,
  text,
  action,
  onClose,
  onConfirm,
}: {
  title: string;
  text: string;
  action: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog
      ref={ref}
      className={`m-rise ${s.dialog}`}
      onClose={onClose}
      aria-labelledby="confirm-title"
    >
      <h3 id="confirm-title" className="t-subtitle">
        {title}
      </h3>
      <p className={`t-small ${s.sub}`}>{text}</p>
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
              await onConfirm();
            } catch (e) {
              setError(message(e));
              setBusy(false);
            }
          }}
        >
          {action}
        </button>
      </div>
    </dialog>
  );
}

function AccountSection() {
  const { boot } = useApp();
  const ctx = boot.state === "ready" ? boot.ctx : undefined;
  const [asking, setAsking] = useState(false);
  return (
    <Section title="Account">
      <button type="button" className={`t-small ${s.linkRow}`} onClick={() => setAsking(true)}>
        Sign out
      </button>
      {asking && (
        <ConfirmDialog
          title="Sign out?"
          text="This browser forgets its keys and leaves your devices. If it is your only device, you need the recovery key to set up another."
          action="Sign out"
          onClose={() => setAsking(false)}
          onConfirm={async () => {
            if (!ctx) return setAsking(false);
            await (await load()).signOut(ctx);
            location.assign("/");
          }}
        />
      )}
    </Section>
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
        <AccountSection />
      </div>
    </>
  );
}
