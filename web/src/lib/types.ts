// Local stand-ins for the packages/protocol schemas (#1). Replace with imports
// from the protocol package once it lands; field names follow SPEC.md.

export type Source = {
  machine: string;
  project: string;
  session: string;
};

export type Answer = {
  value: string;
  at: string;
  device: string;
};

export type Decision = {
  id: string;
  question: string;
  context: string;
  /** 2 to 4 choices, or empty for a free-text answer. */
  options: string[];
  recommended?: string;
  default: { action: string; at: string };
  source: Source;
  askedAt: string;
  answer?: Answer;
};

export type Pace = "on-pace" | "runs-out" | "unused";

export type QuotaWindow = {
  id: string;
  provider: string;
  window: string;
  usedPercent: number;
  /** What a steady pace would have used by now. */
  expectedPercent: number;
  resetsAt: string;
  pace: Pace;
  /** Set when the window resets soon with headroom left, or will run out first. */
  alert?: string;
};

export type DeviceKind = "phone" | "browser" | "machine";

export type Device = {
  id: string;
  name: string;
  kind: DeviceKind;
  addedAt: string;
  lastSeen: string;
  /** Short fingerprint of the device's public key. */
  fingerprint: string;
  status: "active" | "pending" | "revoked";
  /** The device this page runs on. */
  self?: boolean;
  /** Code the CLI printed, shown while a machine waits for approval. */
  pairingCode?: string;
};
