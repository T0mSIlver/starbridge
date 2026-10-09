"use client";

import {
  isShortWindow,
  PUSH_HOLD_CHOICES,
  QUOTA_ALERT_CHOICES,
  type QuotaAlertChoice,
  type QuotaAlertSettings,
  quotaAlertChoices,
  quotaWindowKey,
} from "@starbridge/protocol";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { RecoveryState } from "@/lib/device";
import { addedLabels, dayAndTime } from "@/lib/format";
import { AGENTS_GUIDE } from "@/lib/links";
import { applyTheme, type Prefs, usePref } from "@/lib/prefs";
import type { PushState } from "@/lib/push";
import { holdsQuotas, providerOrder, type QuotaSettings } from "@/lib/quotaSettings";
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
  return (
    <Section title="Inbox">
      <Row label="Answer buttons on questions" sub="On narrow screens">
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

/** What decides whether something notifies here (#914): the browser, sound, and the hold. */
function NotificationSection() {
  const [sound, setSound] = usePref("sound");
  return (
    <Section title="Notifications">
      <BrowserRow />
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
      <HoldRow />
    </Section>
  );
}

/** Whether this browser gets Web Push, and the way to turn it on; the desktop app has its own. */
function BrowserRow() {
  const [state, setState] = useState<PushState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    import("@/lib/push").then((p) => p.pushState()).then(setState);
  }, []);
  if (state === undefined || state === "unsupported") return null;
  const sub =
    error ??
    {
      on: "Questions and permission prompts",
      off: "Questions and permission prompts",
      denied: "Blocked in the browser’s settings for this site",
      install: "Add Starbridge to the Home Screen and open it from there",
    }[state];
  return (
    <Row label="Browser notifications" sub={sub}>
      {state === "off" ? (
        <button
          type="button"
          className={`t-meta ${ui.btn} ${ui.sm}`}
          onClick={async () => {
            setError(undefined);
            try {
              setState(await (await import("@/lib/push")).enablePush());
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          Turn on
        </button>
      ) : (
        <span className={`t-meta ${s.sub}`}>{state === "on" ? "On" : "Off"}</span>
      )}
    </Row>
  );
}

const HOLD_LABELS: Record<(typeof PUSH_HOLD_CHOICES)[number], string> = {
  0: "Off",
  15: "15 s",
  30: "30 s",
  60: "1 min",
  120: "2 min",
};

/**
 * How long other devices' notifications wait while you use a screen (#848): an account setting,
 * since the server holds the pushes. Shown once the server says what it is.
 */
function HoldRow() {
  const [hold, setHold] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    api.settings().then(
      (s) => setHold(s.pushHold),
      // A server without the setting: nothing to show.
      () => {},
    );
  }, []);
  if (hold === undefined) return null;
  return (
    <Row
      label="Hold while you’re at a screen"
      sub={
        error ??
        "While you use Starbridge or a machine with presence on, your other devices are notified only if a question is still open after this"
      }
    >
      <Segmented<number>
        label="Hold while you’re at a screen"
        value={hold}
        options={PUSH_HOLD_CHOICES.map((c) => [c, HOLD_LABELS[c]])}
        onChange={(pushHold) => {
          const was = hold;
          setHold(pushHold);
          setError(undefined);
          api.saveSettings({ pushHold }).catch((e) => {
            setHold(was);
            setError(message(e));
          });
        }}
      />
    </Row>
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
      <Row id="running-out-first" label="Running out first">
        <Switch
          label="Running out first"
          checked={q.runningOutFirst}
          onChange={(runningOutFirst) => patch({ runningOutFirst })}
        />
      </Row>
    </Section>
  );
}

const CHOICE_LABELS: Record<QuotaAlertChoice, string> = {
  "runs-out": "Runs out",
  "low-50": "50% left",
  "low-20": "20% left",
  "unused-headroom": "Unused at reset",
};

const said = (picked: QuotaAlertChoice[]) =>
  picked.length === 0 ? "none" : picked.map((c) => CHOICE_LABELS[c]).join(", ");

/** The alerts a window can pick, any number of them, in their fixed order. */
function Chips({
  label,
  picked,
  onChange,
}: {
  label: string;
  picked: QuotaAlertChoice[];
  onChange: (picked: QuotaAlertChoice[]) => void;
}) {
  return (
    <fieldset className={s.chips} aria-label={label}>
      {QUOTA_ALERT_CHOICES.map((c) => (
        <button
          type="button"
          key={c}
          className={`t-meta ${s.chip}`}
          aria-pressed={picked.includes(c)}
          onClick={() =>
            onChange(QUOTA_ALERT_CHOICES.filter((x) => (x === c) !== picked.includes(x)))
          }
        >
          {CHOICE_LABELS[c]}
        </button>
      ))}
    </fieldset>
  );
}

/** Notification permission comes with the first alert picked, as it came with a provider's bell. */
async function asked() {
  if (typeof Notification !== "undefined" && Notification.permission === "default")
    await Notification.requestPermission();
}

/** The alerts of every window with none of its own, by its length (#914). */
function QuotaAlertSection() {
  const { quotaSettings: q, setQuotaSettings: set } = useApp();
  const patch = async (p: Partial<Pick<QuotaAlertSettings, "short" | "long">>) => {
    if (Object.values(p).some((c) => c.length > 0)) await asked();
    set({ ...q, alerts: { ...q.alerts, ...p } });
  };
  return (
    <Section title="Quota alerts">
      <div className={s.stack}>
        <div className="t-small">5-hour and daily windows</div>
        <Chips
          label="5-hour and daily windows"
          picked={q.alerts.short}
          onChange={(short) => patch({ short })}
        />
      </div>
      <div className={s.stack}>
        <div className="t-small">Weekly and monthly windows</div>
        <Chips
          label="Weekly and monthly windows"
          picked={q.alerts.long}
          onChange={(long) => patch({ long })}
        />
      </div>
    </Section>
  );
}

type Win = { provider: string; id: string; label: string; minutes: number | null };

/**
 * A window's own alerts, or none to follow its length's. A provider's key, which only settings
 * from before #914 hold, first becomes a key per window, so the provider's other windows keep it.
 */
export function setWindowAlerts(
  a: QuotaAlertSettings,
  w: Win,
  all: Win[],
  picked: QuotaAlertChoice[] | undefined,
): QuotaAlertSettings {
  const windows = { ...a.windows };
  const shared = windows[w.provider];
  if (shared) {
    for (const o of all)
      if (o.provider === w.provider) windows[quotaWindowKey(o.provider, o.id)] ??= shared;
    delete windows[w.provider];
  }
  const key = quotaWindowKey(w.provider, w.id);
  if (picked) windows[key] = picked;
  else delete windows[key];
  return { ...a, windows };
}

/** Each window shown, which follows its length's default unless set to its own alerts or off. */
function WindowSection({ wins }: { wins: Win[] }) {
  const { quotaSettings: q, setQuotaSettings: set } = useApp();
  const [open, setOpen] = useState<string>();
  if (wins.length === 0) return null;
  const save = async (w: Win, picked: QuotaAlertChoice[] | undefined) => {
    if (picked?.length) await asked();
    set({ ...q, alerts: setWindowAlerts(q.alerts, w, wins, picked) });
  };
  return (
    <Section title="Per window">
      {wins.map((w) => {
        const key = quotaWindowKey(w.provider, w.id);
        const own = q.alerts.windows[key] ?? q.alerts.windows[w.provider];
        const mode = own === undefined ? "default" : own.length > 0 ? "custom" : "off";
        const length = isShortWindow(w.minutes) ? q.alerts.short : q.alerts.long;
        const picked = quotaAlertChoices(q.alerts, w.provider, w.id, w.minutes);
        const name = `${w.provider} ${w.label}`;
        const state =
          mode === "default"
            ? `Default: ${said(length).toLowerCase()}`
            : own?.length
              ? said(own)
              : "Off";
        const shown = open === key;
        return (
          <div key={key}>
            <button
              type="button"
              className={s.windowHead}
              aria-expanded={shown}
              onClick={() => setOpen(shown ? undefined : key)}
            >
              <span className="t-small">{name}</span>
              <span className={`t-meta ${s.sub}`}>{state}</span>
              <Icon name="down" size={16} />
            </button>
            {shown && (
              <div className={s.stack}>
                <Segmented<typeof mode>
                  label={`Alerts for ${name}`}
                  value={mode}
                  options={[
                    ["default", "Default"],
                    ["custom", "Custom"],
                    ["off", "Off"],
                  ]}
                  onChange={(m) =>
                    save(
                      w,
                      m === "default"
                        ? undefined
                        : m === "off"
                          ? []
                          : picked.length > 0
                            ? picked
                            : ["runs-out"],
                    )
                  }
                />
                {mode === "custom" && (
                  <Chips
                    label={`Alerts for ${name}`}
                    picked={picked}
                    onChange={(p) => save(w, p)}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

/**
 * Everything about quotas, shown once a machine of the account sends them (#914): until then the
 * owner may never use CodexBar, and the page stays about agents.
 */
function QuotaSections() {
  const { quotas, refreshQuotas, quotaSettings: q } = useApp();
  useEffect(() => {
    refreshQuotas().catch(() => {});
  }, [refreshQuotas]);
  if (!holdsQuotas(quotas)) return null;
  const cards = quotas?.cards ?? [];
  const wins: Win[] = [];
  for (const p of providerOrder(cards, q))
    if (!q.hidden.includes(p))
      for (const c of cards)
        if (c.provider === p && !wins.some((w) => w.provider === p && w.id === c.window.id))
          wins.push({
            provider: p,
            id: c.window.id,
            label: c.window.label,
            minutes: c.window.windowMinutes,
          });
  return (
    <>
      <QuotaAlertSection />
      <WindowSection wins={wins} />
      <QuotaSection />
      <ProviderSection />
    </>
  );
}

/** Each provider: drag (or arrow keys on the handle) to reorder, and show. */
function ProviderSection() {
  const { quotas, quotaSettings: q, setQuotaSettings: set } = useApp();
  const cards = quotas?.cards ?? [];
  const providers = providerOrder(cards, q);
  if (providers.length === 0)
    return (
      <Section title="Providers">
        <Row label="No quota windows yet" muted />
      </Section>
    );
  const patch = (p: Partial<QuotaSettings>) => set({ ...q, ...p });
  const moveTo = (p: string, at: number) => {
    const order = providers.filter((x) => x !== p);
    order.splice(Math.max(0, Math.min(at, order.length)), 0, p);
    patch({ order });
  };
  return (
    <Section title="Providers">
      <Providers providers={providers} cards={cards} q={q} moveTo={moveTo} patch={patch} />
    </Section>
  );
}

/** The provider rows, reordered live by their handles (Reorder.tsx). */
function Providers({
  providers,
  cards,
  q,
  moveTo,
  patch,
}: {
  providers: string[];
  cards: QuotaCardData[];
  q: QuotaSettings;
  moveTo: (p: string, at: number) => void;
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
            {d.check && <div className={`t-code ${s.sub}`}>Check code {d.check}</div>}
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
      <a className={s.linkRow} href={AGENTS_GUIDE} target="_blank" rel="noopener noreferrer">
        <span className="t-small">Agent instructions</span>
        <Icon name="open" size={16} />
      </a>
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

/** Colours and the clock: how the page looks, per browser. */
function LookSection() {
  const [theme, setTheme] = usePref("theme");
  const [clock, setClock] = usePref("clock");
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <Section title="Look">
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

export function Settings() {
  return (
    <>
      <PhoneBar title="Settings" find={false} />
      <div className={s.page}>
        <h1 className={`t-heading ${s.title}`}>Settings</h1>
        <NotificationSection />
        <QuotaSections />
        <InboxSection />
        <DeviceSection />
        <LookSection />
        <AccountSection />
      </div>
    </>
  );
}
