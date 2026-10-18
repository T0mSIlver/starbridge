import type { QuotaAlert } from "./schemas";

/**
 * Which quota alerts a device notifies about, per window (#914). The uploader raises every alert
 * at fixed levels (`alertsFor`), so each device filters them by these settings, which stay on it;
 * every client shares this rule and its vectors.
 */
export const QUOTA_ALERT_CHOICES = ["runs-out", "low-50", "low-20", "unused-headroom"] as const;
export type QuotaAlertChoice = (typeof QUOTA_ALERT_CHOICES)[number];

/** Each choice's name, as the alerts table heads its column. */
export const QUOTA_ALERT_LABELS: Record<QuotaAlertChoice, string> = {
  "runs-out": "Runs out",
  "low-50": "50% left",
  "low-20": "20% left",
  "unused-headroom": "Unused",
};

export type QuotaAlertSettings = {
  /** Windows of a day or less. */
  short: QuotaAlertChoice[];
  /** Longer windows, and those of unknown length. */
  long: QuotaAlertChoice[];
  /**
   * A window's own choices, by `provider/window`, where an empty list is off. A key with no
   * window covers every window of its provider that has no key of its own; only settings moved
   * from before #914, by releases up to 0.1.8, hold one.
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
 * The settings with a window's own choices, or with none to follow its length's. A provider's key
 * first becomes a key per window of `all`, so the provider's other windows keep it.
 */
export function withWindowAlerts(
  s: QuotaAlertSettings,
  provider: string,
  window: string,
  all: { provider: string; window: string }[],
  picked: QuotaAlertChoice[] | undefined,
): QuotaAlertSettings {
  const windows = { ...s.windows };
  const shared = windows[provider];
  if (shared) {
    for (const o of all)
      if (o.provider === provider) windows[quotaWindowKey(o.provider, o.window)] ??= shared;
    delete windows[provider];
  }
  const key = quotaWindowKey(provider, window);
  if (picked) windows[key] = picked;
  else delete windows[key];
  return { ...s, windows };
}
