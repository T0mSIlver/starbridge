// The web's view of protocol data (packages/protocol). Components import these as types only;
// the protocol code and libsodium load lazily (lib/device.ts).
import type {
  Decision,
  Member,
  Permission,
  PermissionScope,
  QuotaAlert,
  QuotaWindow,
  Run,
  Settled,
  Source,
} from "@starbridge/protocol";

export type { Decision, Permission, QuotaAlert, QuotaWindow, Run, Settled, Source };

/**
 * A tap on an option, typed text when the decision has none, or Done when it is answered on its
 * own page.
 */
export type Reply = { choice: string } | { text: string } | { done: true };

/** An opened and verified decision. */
export type InboxItem = {
  decision: Decision;
  /** The machine that signed it, which the answer is sealed to. */
  machine: Member;
  /** Set once any device answered. */
  answeredAt?: string;
  /** The answer, when this browser sent it; other devices' answers are sealed to the machine. */
  reply?: Reply;
  /** How the machine closed it, when its settled notice did rather than an answer. */
  settled?: Settled["outcome"];
  /** Another device's answer the machine took, and that device's name, from its settled notice. */
  answeredBy?: { device: string; reply: Reply };
  /** Since when its agent waits on it, having run out of other work (#122). */
  waitingSince?: string;
};

/** An answer to a permission prompt: allow for a scope, or deny with a note to the agent. */
export type PromptReply =
  | { behavior: "allow"; scope: PermissionScope }
  | { behavior: "deny"; scope: "once"; message?: string };

/** An opened and verified permission prompt. */
export type PromptItem = {
  permission: Permission;
  /** The machine that signed it, which the answer is sealed to. */
  machine: Member;
  receivedAt: string;
  /** Set once a device answered it or its machine settled it. */
  answeredAt?: string;
  /** How its machine reports it ended, once that notice arrived. */
  settled?: Settled;
  /** This browser's answer. */
  reply?: PromptReply;
  /** When this page saw it close, so it can say where for a moment. */
  closedAt?: number;
};

/** One quota card: a window, its provider, and the alert raised for it. */
export type QuotaCardData = {
  provider: string;
  /** The machine whose uploader sent it, shown when more than one machine reports. */
  machine?: string;
  window: QuotaWindow;
  /** The pace alert that sets the card's state: will run out, or headroom unused. */
  alert?: QuotaAlert;
  /** Every alert on the window, "low" ones included. */
  alerts: QuotaAlert[];
  /** The snapshot's id. */
  snapshot: string;
  /** Set when CodexBar failed for the provider: the window is the last one read, at `updatedAt`. */
  stale?: { updatedAt: string; error: string };
};

/** An opened and verified run, and the name of the machine that signed it. */
export type RunItem = { run: Run; machine: string };

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

/** A join request as the server relays it (PROTOCOL.md, "Joining by digits"). */
export type JoinView = {
  id: string;
  /** The joining device's request text: JSON of its name and public keys. */
  request: string;
  commitment: string;
  state: "open" | "comparing" | "approved" | "cancelled";
  approver?: string;
  approverKey?: string;
  joinerKey?: string;
  approval?: unknown;
  createdAt: string;
  expiresAt: string;
  version: number;
};

/** A join request as the Devices banner shows it, its request parsed. */
export type JoinAsk = {
  id: string;
  name: string;
  at: string;
  /** Set while a device compares digits for it. */
  approver?: string;
  view: JoinView;
};
