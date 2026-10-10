"use client";

import {
  type NotifyState,
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
import { type DesktopPlace, desktop } from "@/lib/desktop";
import type { RecoveryState } from "@/lib/device";
import { addedLabels, dayAndTime } from "@/lib/format";
import { AGENTS_GUIDE } from "@/lib/links";
import { reports } from "@/lib/notify";
import { applyTheme, type Prefs, usePref } from "@/lib/prefs";
import type { PushState } from "@/lib/push";
import { holdsQuotas, providerOrder, type QuotaSettings } from "@/lib/quotaSettings";
import { keptSettingsData, loadSettingsData, type SettingsData, WAIT_MS } from "@/lib/settingsData";
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
      {/* The one place the keys are written down: hints on some buttons and not others read as
          missing ones (#970). */}
      <Row
        label="Keyboard shortcuts"
        sub="In a window 1100 px wide or more: J and K move through the items, 1 to 4 pick an answer, A allows and D denies a prompt. / goes to Find anywhere."
      />
    </Section>
  );
}

/** What decides whether something notifies here (#914): the browser, sound, and the hold. */
function NotificationSection({ data }: { data: SettingsData }) {
  const [sound, setSound] = usePref("sound");
  return (
    <Section title="Notifications">
      <ThisDeviceRow push={data.push} />
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
      <MacRow />
      <HoldRow initial={data.pushHold} />
    </Section>
  );
}

/**
 * Whether this device notifies (#943): one switch for a browser's Web Push and for the desktop
 * app's own notifications. Each device turns only its own; Devices shows the others'.
 */
function ThisDeviceRow({ push }: { push: PushState }) {
  return desktop ? <AppNotifyRow /> : <BrowserRow initial={push} />;
}

const LABEL = "Notifications on this device";

function AppNotifyRow() {
  const [on, setOn] = usePref("desktopNotify");
  return (
    <Row
      label={LABEL}
      sub={
        on
          ? "Questions and permission prompts"
          : "Off: the window and the menu bar light still show what needs you"
      }
    >
      <Switch
        label={LABEL}
        checked={on}
        onChange={(v) => {
          setOn(v);
          import("@/lib/notify").then((n) => n.report());
        }}
      />
    </Row>
  );
}

/** A browser's Web Push: on asks for the permission first; blocked says where to allow it. */
function BrowserRow({ initial }: { initial: PushState }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string>();
  // A refresh underneath never undoes what the owner just turned on or off.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setState(initial);
  }, [initial]);
  if (state === "unsupported") return null;
  if (state === "install")
    return <Row label={LABEL} sub="Add Starbridge to the Home Screen and open it from there" />;
  const sub =
    error ??
    {
      on: "Questions and permission prompts",
      off: "Off: questions show only while a Starbridge page is open",
      denied:
        "Blocked in this browser. Click the icon left of the address, allow Notifications, then reload.",
    }[state];
  return (
    <Row label={LABEL} sub={<span className={state === "denied" ? s.bad : undefined}>{sub}</span>}>
      <Switch
        label={LABEL}
        checked={state === "on"}
        disabled={state === "denied"}
        onChange={async (on) => {
          touched.current = true;
          setError(undefined);
          try {
            const push = await import("@/lib/push");
            setState(await (on ? push.enablePush() : push.disablePush()));
          } catch (e) {
            setError(message(e));
          }
          (await import("@/lib/notify")).report();
        }}
      />
    </Row>
  );
}

/**
 * In the desktop app, whether the Mac's idle time counts as presence (#945): opt-in, as a
 * machine's `starbridge config presence on` is, since it reports when the owner is at the Mac.
 */
function MacRow() {
  const [on, setOn] = useState(() => desktop?.presence?.());
  if (!desktop?.setPresence || typeof on !== "boolean") return null;
  const save = desktop.setPresence;
  return (
    <Row
      label="Hold while you use this Mac"
      sub="In any app, not only Starbridge. It reads only the time since your last key or click, never which"
    >
      <Switch
        label="Hold while you use this Mac"
        checked={on}
        onChange={(v) => {
          setOn(v);
          save(v);
        }}
      />
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
 * since the server holds the pushes. A server without the setting shows nothing.
 */
function HoldRow({ initial }: { initial: number | undefined }) {
  const [hold, setHold] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setHold(initial);
  }, [initial]);
  if (hold === undefined) return null;
  return (
    <Row
      label="Hold while you’re at a screen"
      sub={
        error ??
        "While you’re using Starbridge or your computer, other devices wait this long to notify"
      }
    >
      <Segmented<number>
        label="Hold while you’re at a screen"
        value={hold}
        options={PUSH_HOLD_CHOICES.map((c) => [c, HOLD_LABELS[c]])}
        onChange={(pushHold) => {
          touched.current = true;
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
      <AlertTable />
    </Section>
  );
}

/** Notification permission comes with the first alert picked, as it came with a provider's bell. */
async function asked() {
  if (typeof Notification !== "undefined" && Notification.permission === "default")
    await Notification.requestPermission();
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

/**
 * Everything about quotas, shown once a machine of the account sends them (#914): until then the
 * owner may never use CodexBar, and the page stays about agents.
 */
function QuotaSections() {
  const { quotas } = useApp();
  if (!holdsQuotas(quotas)) return null;
  return <QuotaSection />;
}

const ALERT_COLUMNS: [QuotaAlertChoice, string, string][] = [
  ["runs-out", "Runs out", "Runs out before its reset at this pace"],
  ["low-50", "50% left", "50% left"],
  ["low-20", "20% left", "20% left"],
  ["unused-headroom", "Unused", "Resets soon with 30% or more unused"],
];

/**
 * Each provider in its order, shown or hidden, with its windows' alerts (#914): drag (or arrow
 * keys on the handle) to reorder.
 */
function AlertTable() {
  const { quotas, quotaSettings: q, setQuotaSettings: set } = useApp();
  const cards = quotas?.cards ?? [];
  const providers = providerOrder(cards, q);
  if (providers.length === 0) return <Row label="No quota windows yet" muted />;
  const patch = (p: Partial<QuotaSettings>) => set({ ...q, ...p });
  const moveTo = (p: string, at: number) => {
    const order = providers.filter((x) => x !== p);
    order.splice(Math.max(0, Math.min(at, order.length)), 0, p);
    patch({ order });
  };
  return (
    <div>
      <div className={`t-meta ${s.alertGrid} ${s.alertHeads}`} aria-hidden>
        <span>Alerts</span>
        {ALERT_COLUMNS.map(([c, label, title]) => (
          <span key={c} title={title}>
            {label}
          </span>
        ))}
      </div>
      <Providers providers={providers} cards={cards} q={q} moveTo={moveTo} patch={patch} />
    </div>
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
  const all: Win[] = [];
  for (const c of cards)
    if (!all.some((w) => w.provider === c.provider && w.id === c.window.id))
      all.push({
        provider: c.provider,
        id: c.window.id,
        label: c.window.label,
        minutes: c.window.windowMinutes,
      });
  const pick = async (w: Win, picked: QuotaAlertChoice[]) => {
    if (picked.length > 0) await asked();
    patch({ alerts: setWindowAlerts(q.alerts, w, all, picked) });
  };
  return (
    <div className={`${s.providers} ${reorder.list.className ?? ""}`}>
      {providers.map((p) => {
        const shown = !q.hidden.includes(p);
        const item = reorder.item(p);
        return (
          <div key={p} ref={item.ref} style={item.style} className={item.className}>
            <div className={s.provider}>
              <button type="button" {...reorder.handle(p)}>
                <Icon name="drag" size={18} />
              </button>
              <span className={`t-small ${s.providerName} ${shown ? "" : s.dim}`}>
                {p}
                {!shown && <span className={`t-meta ${s.sub}`}> · hidden</span>}
              </span>
              <button
                type="button"
                className={s.eye}
                aria-label={`Show ${p}`}
                aria-pressed={shown}
                onClick={() => patch({ hidden: toggle(q.hidden, p, shown) })}
              >
                <Icon name={shown ? "eye" : "hidden"} size={18} />
              </button>
            </div>
            {shown &&
              all
                .filter((w) => w.provider === p)
                .map((w) => {
                  const picked = quotaAlertChoices(q.alerts, w.provider, w.id, w.minutes);
                  return (
                    <div key={w.id} className={`t-small ${s.alertGrid} ${s.alertRow}`}>
                      <span>{w.label}</span>
                      {ALERT_COLUMNS.map(([c, label]) => (
                        // The whole cell takes the tap, as wide as a column and a row tall.
                        <label key={c} className={s.checkCell}>
                          <input
                            type="checkbox"
                            className={s.check}
                            aria-label={`${p} ${w.label}: ${label}`}
                            checked={picked.includes(c)}
                            onChange={(e) =>
                              pick(
                                w,
                                QUOTA_ALERT_CHOICES.filter((x) =>
                                  x === c ? e.target.checked : picked.includes(x),
                                ),
                              )
                            }
                          />
                        </label>
                      ))}
                    </div>
                  );
                })}
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

/** What each device last said of its notifications (#943); only the device itself changes it. */
const NOTIFY_LABELS: Record<NotifyState, string> = {
  on: "Notifications on",
  off: "Notifications off",
  blocked: "Notifications blocked",
};

function DeviceSection({ data }: { data: SettingsData }) {
  const { update, boot, sampleDevices } = useApp();
  const ctx = boot.state === "ready" ? boot.ctx : undefined;
  const [all, setAll] = useState<Device[] | undefined>(sampleDevices ?? data.devices);
  const [revoking, setRevoking] = useState<Device>();
  const [recovery, setRecovery] = useState<RecoveryState | undefined>(data.recovery);
  const [clock] = usePref("clock");
  const [notify, setNotify] = useState<Record<string, NotifyState>>({});
  // Read again when this device's switch reports a new state.
  useEffect(() => {
    if (!ctx) return;
    const read = () => api.notifications().then(setNotify, () => {});
    read();
    reports.addEventListener("change", read);
    return () => reports.removeEventListener("change", read);
  }, [ctx]);
  useEffect(() => {
    if (!data.devices) return;
    setAll(data.devices);
    setRecovery(data.recovery);
  }, [data]);
  // After a revoke, a new ctx: read the devices again.
  const first = useRef(ctx);
  useEffect(() => {
    if (!ctx || ctx === first.current) return;
    first.current = ctx;
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
              {d.self
                ? desktop
                  ? " · this app"
                  : " · this browser"
                : d.addedAt
                  ? ` · ${added.get(d.id)}`
                  : ""}
              {notify[d.id] && (
                <span className={notify[d.id] === "blocked" ? s.bad : undefined}>
                  {` · ${NOTIFY_LABELS[notify[d.id] as NotifyState]}`}
                </span>
              )}
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

const PLACE_SUBS: Record<DesktopPlace, string> = {
  menu: "In the Dock only while its window is open",
  dock: "Always in the Dock, with no menu bar icon",
  both: "Always in the menu bar and the Dock",
};

/** Where the desktop app stays (#936): it is always in one of them, so Starbridge stays at hand. */
function PlaceRow() {
  const [place, setPlace] = useState(() => desktop?.place?.());
  if (!desktop?.setPlace || !place) return null;
  const save = desktop.setPlace;
  return (
    <Row label="Keep Starbridge in" sub={PLACE_SUBS[place]}>
      <Segmented<DesktopPlace>
        label="Keep Starbridge in"
        value={place}
        options={[
          ["menu", "Menu bar"],
          ["dock", "Dock"],
          ["both", "Both"],
        ]}
        onChange={(p) => {
          setPlace(p);
          save(p);
        }}
      />
    </Row>
  );
}

/** Colours and the clock: how the page looks, per browser; in the desktop app, where it stays. */
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
      <PlaceRow />
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

/**
 * The sections show once what they need has arrived, all at once, so the page lays out once
 * (#937): the account's hold, this browser's push, the devices and the quotas. A visit after the
 * first shows the last load at once and refreshes it underneath.
 */
export function Settings() {
  const { boot, refreshQuotas } = useApp();
  const ctx = boot.state === "ready" ? boot.ctx : undefined;
  const [data, setData] = useState(() => keptSettingsData(ctx));
  const [quotasIn, setQuotasIn] = useState(() => !!keptSettingsData(ctx));
  useEffect(() => {
    let live = true;
    loadSettingsData(ctx).then(
      (d) => live && setData(d),
      () => {},
    );
    // The load gives up on the server after WAIT_MS; past twice that, the quotas or a part of
    // this browser hangs, and arrives late rather than holding the page.
    const late = setTimeout(() => {
      setData((d) => d ?? { push: "unsupported" });
      setQuotasIn(true);
    }, 2 * WAIT_MS);
    return () => {
      live = false;
      clearTimeout(late);
    };
  }, [ctx]);
  useEffect(() => {
    refreshQuotas()
      .catch(() => {})
      .finally(() => setQuotasIn(true));
  }, [refreshQuotas]);
  const ready = !!data && quotasIn;
  return (
    <>
      <PhoneBar title="Settings" find={false} />
      <div className={s.page}>
        <h1 className={`t-heading ${s.title}`}>Settings</h1>
        {ready && data && (
          <>
            <NotificationSection data={data} />
            <QuotaSections />
            <InboxSection />
            <DeviceSection data={data} />
            <LookSection />
            <AccountSection />
          </>
        )}
      </div>
    </>
  );
}
