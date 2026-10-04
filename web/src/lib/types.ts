// The web's view of protocol data (packages/protocol). Client components
// import these as types only, so libsodium stays out of the browser bundle
// until #8 needs it.
import type { Answer, Decision, Member, QuotaAlert, QuotaWindow } from "@starbridge/protocol";

export type { Answer, Decision, QuotaAlert, QuotaWindow };

/** A decrypted decision, with its answer once given. */
export type InboxItem = {
  decision: Decision;
  answer?: Answer;
  /** Name of the device that answered. */
  answeredBy?: string;
};

/** One quota card: a window, its provider, and the alert raised for it. */
export type QuotaCardData = {
  provider: string;
  window: QuotaWindow;
  alert?: QuotaAlert;
};

/** A directory member, with what this device knows about it. */
export type Device = Member & {
  kind: "phone" | "browser" | "machine";
  addedAt: string;
  lastSeen: string;
  status: "active" | "pending" | "revoked";
  /** The device this page runs on. */
  self?: boolean;
  /** Code the CLI printed, shown while a machine waits for approval. */
  pairingCode?: string;
};
