// Fake data for the screens until the web is wired to the server (#8). Times
// are fixed relative to NOW so screenshots stay the same.

import type { Decision, Device, QuotaWindow } from "./types";

export const NOW = new Date("2026-10-04T19:00:00Z");

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

export const decisions: Decision[] = [
  {
    id: "d-104",
    question: "Run speech inference on your Mac while you are away?",
    context:
      "The localvoxtral eval needs the Mac's GPU for about 40 minutes. The CI runner is idle. Yes starts now; Tonight books it for 01:00.",
    options: ["Yes, now", "Tonight at 01:00", "No"],
    recommended: "Yes, now",
    default: { action: "Books it for tonight", at: ahead(25) },
    source: { machine: "devbox", project: "localvoxtral", session: "a3f9c2" },
    askedAt: ago(4),
  },
  {
    id: "d-103",
    question: "Merge #42 although the Android lane is still queued?",
    context:
      "The web and server lanes are green. The Android lane waits on the Mac runner and touches no shared file. https://github.com/T0mSIlver/starbridge/pull/42",
    options: ["Merge now", "Wait for the lane"],
    recommended: "Wait for the lane",
    default: { action: "Waits for the lane", at: ahead(90) },
    source: { machine: "devbox", project: "starbridge", session: "orchestrator" },
    askedAt: ago(18),
  },
  {
    id: "d-102",
    question: "What should the release notes call the new dictation mode?",
    context: "The PR calls it 'continuous'. The settings screen says 'hands-free'. Pick one or write another.",
    options: [],
    default: { action: "Keeps 'continuous'", at: ahead(240) },
    source: { machine: "mac", project: "localvoxtral", session: "7be01d" },
    askedAt: ago(52),
  },
  {
    id: "d-101",
    question: "Use Hetzner CX23 for the relay?",
    context: "€5.49 a month, Falkenstein. netcup raised prices 40% on 22 September.",
    options: ["CX23", "CAX11 (Arm)"],
    recommended: "CX23",
    default: { action: "Picks CX23", at: ago(10) },
    source: { machine: "devbox", project: "starbridge", session: "c41e88" },
    askedAt: ago(190),
    answer: { value: "CX23", at: ago(170), device: "Pixel 11 Pro" },
  },
  {
    id: "d-100",
    question: "Name for the decision skill?",
    context: "It replaces needs-you once the service runs.",
    options: [],
    default: { action: "Keeps 'needs-you'", at: ago(60) },
    source: { machine: "devbox", project: "starbridge", session: "orchestrator" },
    askedAt: ago(320),
    answer: { value: "Keep needs-you, alias starbridge-ask", at: ago(300), device: "Firefox on Mac" },
  },
];

export const quotasUpdatedAt = ago(2);

export const quotas: QuotaWindow[] = [
  {
    id: "zai-5h",
    provider: "Z.ai",
    window: "5-hour",
    usedPercent: 22,
    expectedPercent: 80,
    resetsAt: ahead(48),
    pace: "unused",
    alert: "Resets in 48 min with 78% unused. No weekly cap, so it is lost.",
  },
  {
    id: "codex-week",
    provider: "Codex",
    window: "weekly",
    usedPercent: 72,
    expectedPercent: 14,
    resetsAt: ahead(6 * 24 * 60 + 150),
    pace: "runs-out",
    alert: "Runs out in about 9 hours at this pace.",
  },
  {
    id: "claude-week",
    provider: "Claude",
    window: "weekly",
    usedPercent: 65,
    expectedPercent: 56,
    resetsAt: ahead(3 * 24 * 60 + 60),
    pace: "runs-out",
  },
  {
    id: "claude-5h",
    provider: "Claude",
    window: "5-hour",
    usedPercent: 15,
    expectedPercent: 24,
    resetsAt: ahead(180),
    pace: "on-pace",
  },
  {
    id: "codex-5h",
    provider: "Codex",
    window: "5-hour",
    usedPercent: 62,
    expectedPercent: 63,
    resetsAt: ahead(220),
    pace: "on-pace",
  },
  {
    id: "mistral-month",
    provider: "Mistral",
    window: "monthly",
    usedPercent: 20,
    expectedPercent: 13,
    resetsAt: ahead(27 * 24 * 60),
    pace: "on-pace",
  },
];

export const devices: Device[] = [
  {
    id: "dev-1",
    name: "Firefox on Mac",
    kind: "browser",
    addedAt: ago(3 * 24 * 60),
    lastSeen: ago(0),
    fingerprint: "7F3A 91C2",
    status: "active",
    self: true,
  },
  {
    id: "dev-2",
    name: "Pixel 11 Pro",
    kind: "phone",
    addedAt: ago(3 * 24 * 60 - 30),
    lastSeen: ago(6),
    fingerprint: "C0D4 5E18",
    status: "active",
  },
];

export const machines: Device[] = [
  {
    id: "m-3",
    name: "mac",
    kind: "machine",
    addedAt: ago(3),
    lastSeen: ago(1),
    fingerprint: "4B92 E07D",
    status: "pending",
    pairingCode: "481-207",
  },
  {
    id: "m-1",
    name: "devbox",
    kind: "machine",
    addedAt: ago(2 * 24 * 60),
    lastSeen: ago(1),
    fingerprint: "9A1E 33F0",
    status: "active",
  },
  {
    id: "m-2",
    name: "minipc",
    kind: "machine",
    addedAt: ago(2 * 24 * 60),
    lastSeen: ago(26 * 60),
    fingerprint: "E5C2 0B71",
    status: "active",
  },
];

/** An Ed25519 seed printed as words; shown once at first-device setup. */
export const recoveryWords = [
  "orbit", "lantern", "harbor", "velvet", "cobalt", "meadow",
  "signal", "anchor", "ember", "quartz", "willow", "beacon",
  "tundra", "falcon", "prism", "saddle", "glacier", "copper",
  "nectar", "rocket", "summit", "ripple", "canyon", "zephyr",
];
