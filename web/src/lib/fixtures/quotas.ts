// Server-only: computes pace and alerts with the uploader's own code
// (packages/protocol), as the uploader will.
import { alertsFor, computePace, type QuotaWindow } from "@starbridge/protocol";
import { ago, ahead, NOW } from "../now";
import type { QuotaCardData } from "../types";

export const takenAt = ago(2);

const DAY = 24 * 60;

const raw: { provider: string; window: Omit<QuotaWindow, "pace"> }[] = [
  {
    provider: "Z.ai",
    window: {
      id: "primary",
      label: "5-hour",
      usedPercent: 22,
      windowMinutes: 300,
      resetsAt: ahead(48),
    },
  },
  {
    provider: "Codex",
    window: {
      id: "secondary",
      label: "Weekly",
      usedPercent: 72,
      windowMinutes: 7 * DAY,
      resetsAt: ahead(6 * DAY + 150),
    },
  },
  {
    provider: "Claude",
    window: {
      id: "secondary",
      label: "Weekly",
      usedPercent: 65,
      windowMinutes: 7 * DAY,
      resetsAt: ahead(3 * DAY + 60),
    },
  },
  {
    provider: "Claude",
    window: {
      id: "primary",
      label: "5-hour",
      usedPercent: 15,
      windowMinutes: 300,
      resetsAt: ahead(180),
    },
  },
  {
    provider: "Codex",
    window: {
      id: "primary",
      label: "5-hour",
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: ahead(220),
    },
  },
  {
    provider: "Mistral",
    window: {
      id: "monthly",
      label: "Monthly",
      usedPercent: 9,
      windowMinutes: 30 * DAY,
      resetsAt: ahead(27 * DAY),
    },
  },
];

export const quotas: QuotaCardData[] = raw.map(({ provider, window }) => {
  const w: QuotaWindow = { ...window, pace: computePace(window, NOW) };
  // One card shows one alert; running out matters more than waste.
  const alerts = alertsFor(provider, w, NOW);
  return { provider, window: w, alert: alerts.find((a) => a.kind === "runs-out") ?? alerts[0] };
});
