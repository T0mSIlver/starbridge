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

/**
 * Kinds of sealed item, and for each: the role that signs it (it is sealed to members of the
 * other role: a machine's items to every active device, a device's to the one machine it
 * answers), and for a kind that refers to an earlier item, the body field naming it and that
 * item's kind. The item's `re` hint repeats that field.
 */
export const ITEM_KINDS = {
  decision: { signer: "machine" },
  answer: { signer: "device", re: { field: "decisionId", kind: "decision" } },
  quota: { signer: "machine" },
  permission: { signer: "machine" },
  "permission-answer": { signer: "device", re: { field: "permissionId", kind: "permission" } },
  settled: { signer: "machine", re: { field: "permissionId", kind: "permission" } },
} as const satisfies Record<
  string,
  { signer: "device" | "machine"; re?: { field: string; kind: string } }
>;

export type ItemKind = keyof typeof ITEM_KINDS;
const ITEM_KIND_NAMES = Object.keys(ITEM_KINDS) as [ItemKind, ...ItemKind[]];
export const ItemKind = z.enum(ITEM_KIND_NAMES);

export const Kind = z.enum(["directory", ...ITEM_KIND_NAMES]);
export type Kind = z.infer<typeof Kind>;

/** The id an item refers to through its kind's `re` field, if the kind has one. */
export function reOf(kind: ItemKind, body: object): string | undefined {
  const rule = ITEM_KINDS[kind];
  if (!("re" in rule)) return undefined;
  return (body as Record<string, unknown>)[rule.re.field] as string;
}

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
  /**
   * Directory entry 0 only: the recovery key's signature over the same body, as signer
   * "recovery". It ties the genesis to the recovery key, so a server that copies the public
   * recovery key into a genesis of its own cannot pass it off during recovery.
   */
  recoverySig: B64.optional(),
});
export type SignedEnvelope = z.infer<typeof SignedEnvelope>;

/**
 * What the server stores and relays: one sealed box per recipient. `id`, `kind`, `from`, `re` and
 * `to` are routing hints the server can read; clients check them against the signed body inside.
 */
export const SealedItem = z.object({
  v: z.literal(1),
  kind: ItemKind,
  id: Id,
  from: Id,
  /**
   * The item this one refers to (ITEM_KINDS' `re`): the decision an answer answers, the
   * permission a permission answer or a settled notice closes. The server marks it answered.
   */
  re: Id.optional(),
  boxes: z
    .array(z.object({ to: Id, box: B64 }))
    .min(1)
    .max(64),
});
export type SealedItem = z.infer<typeof SealedItem>;

// --- Decisions and answers ---------------------------------------------------

/**
 * Where the owner can open the session that asked: Remote Control or a cloud session on
 * claude.ai/code (the Claude app opens these on a phone), or Claude Desktop.
 */
export const SessionLinkKind = z.enum(["remote-control", "desktop", "web"]);
export type SessionLinkKind = z.infer<typeof SessionLinkKind>;

/** The only URLs each kind may carry, so a client never opens a script or another site. */
export const SESSION_LINK_PREFIX: Record<SessionLinkKind, string> = {
  "remote-control": "https://claude.ai/code/",
  web: "https://claude.ai/code/",
  desktop: "claude://claude.ai/",
};

export const SessionLink = z
  .object({
    kind: SessionLinkKind,
    url: z
      .string()
      .max(2048)
      .regex(/^[\x21-\x7e]+$/, "printable ASCII"),
  })
  .refine((l) => l.url.startsWith(SESSION_LINK_PREFIX[l.kind]), {
    message: "url does not match its kind",
  });
export type SessionLink = z.infer<typeof SessionLink>;

/** The machine, project and session an item comes from. */
export const Source = z.object({
  machine: z.string().min(1).max(100),
  project: z.string().max(200),
  session: z.string().max(200),
  /** The session's name, as Claude Code shows it. Optional: older machines omit it. */
  sessionTitle: z.string().max(200).optional(),
  links: z.array(SessionLink).max(3).optional(),
});
export type Source = z.infer<typeof Source>;

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
    source: Source,
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

// --- Permission prompts -----------------------------------------------------

/** A permission prompt lives at most this long; the server refuses answers after it. */
export const PERMISSION_TTL_MS = 10 * 60 * 1000;

export const PermissionAgent = z.enum(["claude-code", "codex"]);
export type PermissionAgent = z.infer<typeof PermissionAgent>;

/** How far an allow reaches: this call, the rest of the session, or always in this project. */
export const PermissionScope = z.enum(["once", "session", "project"]);
export type PermissionScope = z.infer<typeof PermissionScope>;

/**
 * A wider allow the machine offers, shown with the exact rule it would add. The machine keeps
 * the rule it would write; an answer names only the scope, so a device cannot inject a rule.
 */
export const PermissionSuggestion = z.object({
  label: z.string().min(1).max(100),
  rule: z.string().min(1).max(500),
  scope: z.enum(["session", "project"]),
});
export type PermissionSuggestion = z.infer<typeof PermissionSuggestion>;

/** An agent waiting at a permission prompt, as the machine shows it to devices. */
export const Permission = z
  .object({
    v: z.literal(1),
    id: Id,
    to: z.array(Id).min(1),
    createdAt: Time,
    agent: PermissionAgent,
    tool: z.string().min(1).max(100),
    /** One line: the Bash command, or the edited path. */
    summary: z.string().min(1).max(200),
    /** What the agent says the call does. */
    description: z.string().max(500).optional(),
    /** The tool's input as JSON text, with secrets redacted on the machine. */
    input: z.string().max(8000),
    /** BLAKE2b-256 of the tool input before redaction (`hashInput`); answers repeat it. */
    inputHash: B64,
    suggestions: z.array(PermissionSuggestion).max(2),
    expiresAt: Time,
    source: Source,
  })
  .superRefine((p, ctx) => {
    const ttl = Date.parse(p.expiresAt) - Date.parse(p.createdAt);
    if (!(ttl > 0 && ttl <= PERMISSION_TTL_MS))
      ctx.addIssue({ code: "custom", message: "expiresAt: after createdAt, at most 10 minutes" });
    if (new Set(p.suggestions.map((x) => x.scope)).size !== p.suggestions.length)
      ctx.addIssue({ code: "custom", message: "one suggestion per scope" });
  });
export type Permission = z.infer<typeof Permission>;

/** A device's answer to a permission prompt, bound to its id and its input's hash. */
export const PermissionAnswer = z
  .object({
    v: z.literal(1),
    id: Id,
    permissionId: Id,
    /** The machine that asked. */
    to: Id,
    answeredAt: Time,
    behavior: z.enum(["allow", "deny"]),
    scope: PermissionScope,
    inputHash: B64,
    /** On a deny: what the agent should do instead. */
    message: z.string().max(500).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.behavior === "deny" && a.scope !== "once")
      ctx.addIssue({ code: "custom", message: "a deny is for this call only" });
    if (a.behavior === "allow" && a.message !== undefined)
      ctx.addIssue({ code: "custom", message: "message is for a deny" });
  });
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;

/**
 * The machine's notice that a prompt is over: answered at the keyboard or in the Claude app,
 * timed out, or resolved by a device's answer (`device` names it).
 */
export const Settled = z
  .object({
    v: z.literal(1),
    id: Id,
    permissionId: Id,
    to: z.array(Id).min(1),
    outcome: z.enum(["keyboard", "timeout", "device"]),
    /** With outcome "device": the device whose answer the machine applied. */
    device: Id.optional(),
    at: Time,
  })
  .refine((s) => (s.outcome === "device") === (s.device !== undefined), {
    message: "device is set exactly when outcome is device",
  });
export type Settled = z.infer<typeof Settled>;

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
  permission: Permission,
  "permission-answer": PermissionAnswer,
  settled: Settled,
} as const satisfies Record<Kind, z.ZodType>;

export type BodyOf<K extends Kind> = z.infer<(typeof BODY_SCHEMAS)[K]>;
