import type { QuotaAlert } from "./schemas";

/**
 * Which quota alerts a device notifies about, per window (#914). The uploader raises every alert
 * at fixed levels (`alertsFor`), so each device filters them by these settings, which stay on it;
 * Android and the web share this rule and its vectors.
 */
export const QUOTA_ALERT_CHOICES = ["runs-out", "low-50", "low-20", "unused-headroom"] as const;
export type QuotaAlertChoice = (typeof QUOTA_ALERT_CHOICES)[number];

export type QuotaAlertSettings = {
  /** Windows of a day or less. */
  short: QuotaAlertChoice[];
  /** Longer windows, and those of unknown length. */
  long: QuotaAlertChoice[];
  /**
   * A window's own choices, by `provider/window`, where an empty list is off. A key with no
   * window covers every window of its provider that has no key of its own; only settings from
   * before #914 write one.
   */
  windows: Record<string, QuotaAlertChoice[]>;
};

/** A 5-hour window that runs out resets within hours; a weekly one costs days. */
export const DEFAULT_QUOTA_ALERTS: QuotaAlertSettings = {
  short: [],
  long: ["runs-out"],
  windows: {},
};

export const quotaWindowKey = (provider: string, window: string) => `${provider}/${window}`;

/** A window of a day or less, as `alertsFor` tells them apart. */
export const isShortWindow = (minutes: number | null) => minutes !== null && minutes <= 24 * 60;

/** What a window notifies about: its own choices, else its provider's, else its length's. */
export function quotaAlertChoices(
  s: QuotaAlertSettings,
  provider: string,
  window: string,
  minutes: number | null,
): QuotaAlertChoice[] {
  return (
    s.windows[quotaWindowKey(provider, window)] ??
    s.windows[provider] ??
    (isShortWindow(minutes) ? s.short : s.long)
  );
}

/**
 * Whether an alert notifies under the settings. `alertsFor` raises only the lowest level reached,
 * so a window that skips past a level picked still notifies at the next one down.
 */
export function wantsQuotaAlert(
  s: QuotaAlertSettings,
  alert: Pick<QuotaAlert, "provider" | "window" | "kind"> & { threshold?: number },
  minutes: number | null,
): boolean {
  const picked = quotaAlertChoices(s, alert.provider, alert.window, minutes);
  if (alert.kind !== "low") return picked.includes(alert.kind);
  const threshold = alert.threshold ?? 0;
  return picked.some((c) => c.startsWith("low-") && Number(c.slice(4)) >= threshold);
}

/**
 * Settings from before #914: a bell per provider, and two switches for every provider whose bell
 * was on, "runs low" (50% and 20% left) and "runs out" (which also covered unused headroom).
 * Each provider with its bell on keeps what the switches let through; the others get the defaults.
 */
export function migrateQuotaAlerts(old: {
  notify: string[];
  notifyLow?: boolean;
  notifyPace?: boolean;
}): QuotaAlertSettings {
  const kept: QuotaAlertChoice[] = [
    ...(old.notifyPace !== false ? (["runs-out"] as const) : []),
    ...(old.notifyLow !== false ? (["low-50", "low-20"] as const) : []),
    ...(old.notifyPace !== false ? (["unused-headroom"] as const) : []),
  ];
  return {
    ...DEFAULT_QUOTA_ALERTS,
    windows: Object.fromEntries(old.notify.map((p) => [p, kept])),
  };
}
