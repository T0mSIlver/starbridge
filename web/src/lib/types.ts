// The web's view of protocol data (packages/protocol). Components import these as types only;
// the protocol code and libsodium load lazily (lib/device.ts).
import type { Decision, Member, QuotaAlert, QuotaWindow } from "@starbridge/protocol";

export type { Decision, QuotaAlert, QuotaWindow };

/** A tap on an option, or typed text when the decision has none. */
export type Reply = { choice: string } | { text: string };

/** An opened and verified decision. */
export type InboxItem = {
  decision: Decision;
  /** The machine that signed it, which the answer is sealed to. */
  machine: Member;
  /** Set once any device answered. */
  answeredAt?: string;
  /** The answer, when this browser sent it; other devices' answers are sealed to the machine. */
  reply?: Reply;
};

/** One quota card: a window, its provider, and the alert raised for it. */
export type QuotaCardData = {
  provider: string;
  /** The machine whose uploader sent it, shown when more than one machine reports. */
  machine?: string;
  window: QuotaWindow;
  alert?: QuotaAlert;
};

/** A directory member, as the Devices screen lists it. */
export type Device = Member & {
  addedAt: string;
  status: "active" | "revoked";
  /** The device this page runs on. */
  self?: boolean;
};

/** A pairing request whose MAC checked out against the typed code. */
export type PairingRequest = {
  code: string;
  role: Member["role"];
  id: string;
  name: string;
  boxPk: string;
  signPk: string;
  at: string;
};
