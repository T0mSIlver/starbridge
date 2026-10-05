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
 * item's possible kinds. The item's `re` hint repeats that field, and the server marks the
 * referred item answered, unless the kind is `open` (it describes the item, closing nothing).
 * A kind with `updates` is re-posted under the same id as it changes, and the server keeps
 * only the latest.
 */
export const ITEM_KINDS = {
  decision: { signer: "machine" },
  answer: { signer: "device", re: { field: "decisionId", kinds: ["decision"] } },
  quota: { signer: "machine" },
  permission: { signer: "machine" },
  "permission-answer": { signer: "device", re: { field: "permissionId", kinds: ["permission"] } },
  settled: { signer: "machine", re: { field: "itemId", kinds: ["permission", "decision"] } },
  run: { signer: "machine", updates: true },
  waiting: {
    signer: "machine",
    re: { field: "decisionId", kinds: ["decision"], open: true },
    updates: true,
  },
} as const satisfies Record<
  string,
  {
    signer: "device" | "machine";
    re?: { field: string; kinds: readonly string[]; open?: true };
    updates?: true;
  }
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
  /** Store without pushing: a quota snapshot that raises no new alert. */
  quiet: z.literal(true).optional(),
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

/** The coding agent behind a decision or a permission prompt. */
export const Agent = z.enum(["claude-code", "codex"]);
export type Agent = z.infer<typeof Agent>;

/** What a machine is, for its icon; clients without it show a generic computer. */
export const MachineKind = z.enum(["server", "desktop", "laptop", "cloud"]);
export type MachineKind = z.infer<typeof MachineKind>;

/** The machine, project and session an item comes from. */
export const Source = z.object({
  machine: z.string().min(1).max(100),
  /** Optional: older machines omit it. */
  machineKind: MachineKind.optional(),
  project: z.string().max(200),
  session: z.string().max(200),
  /** The session's name, as Claude Code shows it. Optional: older machines omit it. */
  sessionTitle: z.string().max(200).optional(),
  links: z.array(SessionLink).max(3).optional(),
});
export type Source = z.infer<typeof Source>;

/**
 * A picture the agent attaches to a decision: a mockup, a failing screen, a chart. It travels
 * inside the signed and sealed body like the text, so it costs its size once per box; the CLI
 * downscales images to keep a decision within the server's per-item cap (PROTOCOL.md, Limits).
 */
export const DecisionImage = z.object({
  /** PNG or JPEG only: never SVG, which can carry script. */
  type: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  data: B64.max(512 * 1024),
  /** What the image shows, for screen readers and the notification. */
  alt: z.string().max(300).optional(),
});
export type DecisionImage = z.infer<typeof DecisionImage>;

/**
 * A page the owner may open to decide, typically a claude.ai artifact the agent built. HTTPS
 * only, so a client never opens a script or an app scheme.
 */
export const DecisionLink = z.object({
  url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[\x21-\x7e]+$/, "an https URL in printable ASCII"),
  title: z.string().min(1).max(100).optional(),
});
export type DecisionLink = z.infer<typeof DecisionLink>;

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
    /** Optional: older machines omit it. */
    agent: Agent.optional(),
    /**
     * Optional, and no client shows it: agents never answer for the owner, so a decision has no
     * default. Machines keep sending one for clients from before 2026-10-05, which require it;
     * its `at`, if any, is dropped.
     */
    default: z.object({ action: z.string().min(1).max(300) }).optional(),
    source: Source,
    images: z.array(DecisionImage).max(4).optional(),
    links: z.array(DecisionLink).max(4).optional(),
    /**
     * Set when the owner answers on that page, such as a claude.ai artifact whose button wakes
     * the agent, and not in Starbridge: the decision then has no options, and closes when the
     * machine posts `settled`. Never both, so the owner
     * never answers one question in two places.
     */
    answerIn: DecisionLink.optional(),
    /**
     * The machine takes a typed reply in place of one of the options (#201): clients then offer
     * "Reply" under them. Machines from before it leave it out and accept only a choice.
     */
    replies: z.literal(true).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.options.length === 1) ctx.addIssue({ code: "custom", message: "options: 0 or 2 to 4" });
    if (new Set(d.options).size !== d.options.length)
      ctx.addIssue({ code: "custom", message: "options must be distinct" });
    if (d.options.length > 0 && (d.recommended === undefined || !d.options.includes(d.recommended)))
      ctx.addIssue({ code: "custom", message: "recommended must be one of the options" });
    if (d.options.length === 0 && d.recommended !== undefined)
      ctx.addIssue({ code: "custom", message: "recommended needs options" });
    if (d.answerIn !== undefined && d.options.length > 0)
      ctx.addIssue({ code: "custom", message: "a decision answered elsewhere has no options" });
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

export const PermissionAgent = Agent;
export type PermissionAgent = Agent;

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
 * The machine's notice that one of its items no longer waits for an answer: a permission
 * answered at the keyboard or in the Claude app, timed out, or resolved by a device's answer
 * (`device` names it); or a decision answered outside Starbridge (`elsewhere`, such as the
 * page its `answerIn` names) or withdrawn by the agent.
 */
export const Settled = z
  .object({
    v: z.literal(1),
    id: Id,
    /** The permission or decision it closes, posted by the same machine. */
    itemId: Id,
    to: z.array(Id).min(1),
    at: Time,
    outcome: z.enum(["keyboard", "timeout", "device", "elsewhere", "withdrawn"]).optional(),
    /** With outcome "device": the device whose answer the machine applied. */
    device: Id.optional(),
  })
  .refine((s) => (s.outcome === "device") === (s.device !== undefined), {
    message: "device is set exactly when outcome is device",
  });
export type Settled = z.infer<typeof Settled>;

/**
 * Whether the agent is blocked on one of its machine's decisions: `working` on other things, or
 * `waiting` for the owner. The machine re-posts it under one id per decision whenever the agent
 * flips it; devices keep the update with the latest `at`. A decision without one is `working`.
 */
export const Waiting = z.object({
  v: z.literal(1),
  id: Id,
  decisionId: Id,
  to: z.array(Id).min(1),
  at: Time,
  state: z.enum(["working", "waiting"]),
});
export type Waiting = z.infer<typeof Waiting>;

// --- Runs --------------------------------------------------------------------

/** A machine re-posts a running run at least this often, progress or not. */
export const RUN_HEARTBEAT_MS = 60 * 1000;
/** A running run with no update for this long has lost its machine: devices stop showing it. */
export const RUN_STALE_MS = 3 * RUN_HEARTBEAT_MS;

/** What a command's output said of its progress: `[3/7]` as steps, `42%` or OSC 9;4 as percent. */
export const RunProgress = z
  .object({
    done: z.number().int().min(0),
    total: z.number().int().min(1),
    unit: z.enum(["step", "percent"]),
  })
  .refine((p) => p.done <= p.total, { message: "done is at most total" })
  .refine((p) => p.unit === "step" || p.total === 100, { message: "a percent is out of 100" });
export type RunProgress = z.infer<typeof RunProgress>;

/**
 * A command an agent wrapped in `starbridge run` because one of the owner's rules matched it.
 * The machine re-posts it under the same id as it progresses and once it exits; devices keep the
 * update with the latest `at`.
 */
export const Run = z
  .object({
    v: z.literal(1),
    id: Id,
    to: z.array(Id).min(1),
    title: z.string().min(1).max(100),
    /** Why the owner hears of it, e.g. "uses your session and keyboard". */
    reason: z.string().min(1).max(200),
    source: Source,
    startedAt: Time,
    /** When the machine sent this update. */
    at: Time,
    progress: RunProgress.optional(),
    /** Set once the command exited: its exit code (128 + n when signal n ended it). */
    exit: z.object({ code: z.number().int().min(0).max(255), at: Time }).optional(),
  })
  .superRefine((r, ctx) => {
    if (Date.parse(r.at) < Date.parse(r.startedAt))
      ctx.addIssue({ code: "custom", message: "at: not before startedAt" });
    if (r.exit && Date.parse(r.exit.at) < Date.parse(r.startedAt))
      ctx.addIssue({ code: "custom", message: "exit.at: not before startedAt" });
  });
export type Run = z.infer<typeof Run>;

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

/**
 * A window the uploader alerts on. It repeats in every snapshot while it holds; `notify` marks
 * the one snapshot that first raised it in this window's cycle, the one that asked for a push.
 */
const AlertBase = {
  provider: z.string(),
  window: z.string(),
  resetsAt: Time,
  notify: z.literal(true).optional(),
};

export const QuotaAlert = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unused-headroom"),
    ...AlertBase,
    /** Percent left unused at reset at the current rate. */
    unusedPercent: z.number(),
  }),
  z.object({
    kind: z.literal("runs-out"),
    ...AlertBase,
    runsOutAt: Time,
  }),
  z.object({
    /** At most `threshold` percent left (CodexBar's quota warning thresholds). */
    kind: z.literal("low"),
    ...AlertBase,
    threshold: z.number().int().min(1).max(99),
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
  run: Run,
  waiting: Waiting,
} as const satisfies Record<Kind, z.ZodType>;

export type BodyOf<K extends Kind> = z.infer<(typeof BODY_SCHEMAS)[K]>;
