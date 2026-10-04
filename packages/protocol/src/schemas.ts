import { z } from "zod";

export const B64 = z.string().regex(/^[A-Za-z0-9_-]+$/, "base64url without padding");
/** Ids of members, decisions, answers and snapshots. */
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const Time = z.iso.datetime({ offset: true });

// --- Directory --------------------------------------------------------------

export const Role = z.enum(["device", "machine"]);
export type Role = z.infer<typeof Role>;

/** A device (phone, browser) or a machine (where agents run) and its public keys. */
export const Member = z.object({
  id: Id,
  role: Role,
  name: z.string().min(1).max(100),
  /** X25519, for sealed boxes. */
  boxPk: B64,
  /** Ed25519, for signatures. */
  signPk: B64,
});
export type Member = z.infer<typeof Member>;

const EntryBase = {
  v: z.literal(1),
  account: Id,
  seq: z.number().int().nonnegative(),
  /** Hash of the previous entry's body; null only on the first entry. */
  prev: B64.nullable(),
  at: Time,
};

export const AddEntry = z.object({
  ...EntryBase,
  op: z.literal("add"),
  member: Member,
  /** Ed25519 public key of the recovery seed. Required on the first entry, absent after. */
  recoveryPk: B64.optional(),
});

export const RevokeEntry = z.object({
  ...EntryBase,
  op: z.literal("revoke"),
  id: Id,
});

export const DirectoryEntry = z.discriminatedUnion("op", [AddEntry, RevokeEntry]);
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

// --- Signed and sealed envelopes ---------------------------------------------

export const Kind = z.enum(["directory", "decision", "answer", "quota"]);
export type Kind = z.infer<typeof Kind>;

/** The signer's member id, or "recovery" for a directory entry signed by the recovery key. */
export const RECOVERY = "recovery";

/**
 * `body` is the JSON text exactly as signed. Verifiers check the signature over these bytes and
 * only then parse them, so nobody ever re-serializes JSON to check a signature.
 */
export const SignedEnvelope = z.object({
  v: z.literal(1),
  kind: Kind,
  signer: Id,
  body: z.string(),
  sig: B64,
});
export type SignedEnvelope = z.infer<typeof SignedEnvelope>;

/**
 * What the server stores and relays: one sealed box per recipient. `id`, `kind`, `from`, `re` and
 * `to` are routing hints the server can read; clients check them against the signed body inside.
 */
export const SealedItem = z.object({
  v: z.literal(1),
  kind: z.enum(["decision", "answer", "quota"]),
  id: Id,
  from: Id,
  /** On an answer: the decision it answers, so the server can mark that decision answered. */
  re: Id.optional(),
  boxes: z
    .array(z.object({ to: Id, box: B64 }))
    .min(1)
    .max(64),
});
export type SealedItem = z.infer<typeof SealedItem>;

// --- Decisions and answers ---------------------------------------------------

export const Decision = z
  .object({
    v: z.literal(1),
    id: Id,
    /** Device ids this decision was sealed to. */
    to: z.array(Id).min(1),
    createdAt: Time,
    question: z.string().min(1).max(300),
    context: z.string().max(8000),
    /** 2 to 4 choices, or none for a free-text answer. */
    options: z.array(z.string().min(1).max(100)).max(4),
    recommended: z.string().optional(),
    default: z.object({
      /** What the agent does if nobody answers. */
      action: z.string().min(1).max(300),
      at: Time.optional(),
    }),
    source: z.object({
      machine: z.string().min(1).max(100),
      project: z.string().max(200),
      session: z.string().max(200),
    }),
  })
  .superRefine((d, ctx) => {
    if (d.options.length === 1) ctx.addIssue({ code: "custom", message: "options: 0 or 2 to 4" });
    if (new Set(d.options).size !== d.options.length)
      ctx.addIssue({ code: "custom", message: "options must be distinct" });
    if (d.options.length > 0 && (d.recommended === undefined || !d.options.includes(d.recommended)))
      ctx.addIssue({ code: "custom", message: "recommended must be one of the options" });
    if (d.options.length === 0 && d.recommended !== undefined)
      ctx.addIssue({ code: "custom", message: "recommended needs options" });
  });
export type Decision = z.infer<typeof Decision>;

export const Answer = z
  .object({
    v: z.literal(1),
    id: Id,
    decisionId: Id,
    /** The machine that asked. */
    to: Id,
    answeredAt: Time,
    choice: z.string().max(100).optional(),
    text: z.string().max(4000).optional(),
  })
  .refine((a) => (a.choice === undefined) !== (a.text === undefined), {
    message: "exactly one of choice and text",
  });
export type Answer = z.infer<typeof Answer>;

// --- Quotas ------------------------------------------------------------------

export const PaceStage = z.enum(["ahead", "on-track", "behind", "unknown"]);
export type PaceStage = z.infer<typeof PaceStage>;

/** Where usage is heading at the current rate. Percent values are rounded to 0.1. */
export const Pace = z.object({
  /** ahead: using faster than an even pace; behind: slower, headroom left. */
  stage: PaceStage,
  /** What an even pace would have used by now. */
  expectedUsedPercent: z.number(),
  /** usedPercent minus expectedUsedPercent. */
  deltaPercent: z.number(),
  /** Usage at reset at the current rate; null while too early to tell. */
  projectedUsedPercent: z.number().nullable(),
  willLastToReset: z.boolean(),
  runsOutAt: Time.nullable(),
});
export type Pace = z.infer<typeof Pace>;

export const QuotaWindow = z.object({
  /** CodexBar's key: "primary", "secondary" or an extra window's id. */
  id: z.string().min(1).max(100),
  label: z.string().max(100),
  usedPercent: z.number().nonnegative(),
  windowMinutes: z.number().int().positive().nullable(),
  resetsAt: Time.nullable(),
  pace: Pace.nullable(),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const QuotaAlert = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unused-headroom"),
    provider: z.string(),
    window: z.string(),
    resetsAt: Time,
    /** Percent left unused at reset at the current rate. */
    unusedPercent: z.number(),
  }),
  z.object({
    kind: z.literal("runs-out"),
    provider: z.string(),
    window: z.string(),
    resetsAt: Time,
    runsOutAt: Time,
  }),
]);
export type QuotaAlert = z.infer<typeof QuotaAlert>;

export const QuotaSnapshot = z.object({
  v: z.literal(1),
  id: Id,
  to: z.array(Id).min(1),
  takenAt: Time,
  providers: z.array(
    z.object({
      provider: z.string().min(1).max(100),
      account: z.string().max(200).optional(),
      windows: z.array(QuotaWindow),
      /** Set when CodexBar failed for this provider. */
      error: z.string().max(1000).optional(),
    }),
  ),
  alerts: z.array(QuotaAlert),
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>;

export const BODY_SCHEMAS = {
  directory: DirectoryEntry,
  decision: Decision,
  answer: Answer,
  quota: QuotaSnapshot,
} as const;

export type BodyOf<K extends Kind> = z.infer<(typeof BODY_SCHEMAS)[K]>;
