/**
 * Permission prompts (#57): what `starbridge hook permission` posts when a coding agent stops at
 * a permission prompt, how the machine accepts a device's answer, and how a prompt is settled.
 * The agent and the CLI's own path (no agent) share this file and the state file.
 */
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  checkPermissionAnswer,
  type Directory,
  hashInput,
  open,
  PERMISSION_TTL_MS,
  type Permission,
  type PermissionAnswer,
  Permission as PermissionSchema,
  type PermissionScope,
  ProtocolError,
  parseWith,
  SealedItem,
  type Settled,
  seal,
} from "@starbridge/protocol";
import { claudeSession } from "./claude";
import type { PendingPermission, PermissionUpdate, State } from "./config";
import { type Ctx, devices, iso, refreshDirectory, type Session, UsageError } from "./context";

/** What Claude Code's `PermissionRequest` hook gets on stdin (fields Starbridge reads). */
export interface PermissionHookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  permission_mode?: string;
  /** The SDK's `PermissionUpdate` objects Claude Code would offer at the keyboard. */
  permission_suggestions?: unknown[];
}

/** What the posting process knows about where the prompt comes from. */
export interface PermissionSourceInput {
  project: string;
  session: string;
  sessionTitle?: string;
  links?: Permission["source"]["links"];
}

/** How long the hook waits by default: under the 600 s both agents give a hook. */
export const DEFAULT_WAIT_MS = 570_000;
const INPUT_MAX = 8000;
const SUMMARY_MAX = 200;
const DESCRIPTION_MAX = 500;
const RULE_MAX = 500;
/** Waiting prompts older than this are dropped from the state: they expired long ago. */
const KEEP_MS = 24 * 3600_000;

// --- Redaction ----------------------------------------------------------------

const REDACTED = "[redacted]";

/** Token shapes of common providers, after Claude Code 2.1.234's list, plus PEM blocks. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bey[JI][A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** `FOO_KEY=…`, `GITHUB_TOKEN: …`, `--password=…`: the value goes. */
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&|]+)/gi;

/** Removes secrets from one string. */
export function redactText(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  return out.replace(ASSIGNMENT, (_, name: string, sep: string) => `${name}${sep}${REDACTED}`);
}

/** Redacts every string in a JSON value, keys included. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redactText(k), redactValue(v)]),
    );
  return value;
}

/** JSON text of `value` within `max` characters: the longest strings are cut until it fits. */
export function fitJson(value: unknown, max = INPUT_MAX): string {
  let v = value;
  let text = JSON.stringify(v) ?? "null";
  for (let round = 0; text.length > max && round < 64; round++) {
    const over = text.length - max;
    let longest: { path: (string | number)[]; len: number } | undefined;
    const walk = (x: unknown, path: (string | number)[]) => {
      if (typeof x === "string") {
        if (!longest || x.length > longest.len) longest = { path, len: x.length };
      } else if (Array.isArray(x)) {
        for (const [i, y] of x.entries()) walk(y, [...path, i]);
      } else if (x && typeof x === "object")
        for (const [k, y] of Object.entries(x)) walk(y, [...path, k]);
    };
    walk(v, []);
    if (!longest || longest.len < 40) break;
    const keep = Math.max(20, longest.len - over - 40);
    v = setAt(v, longest.path, (s: string) => `${s.slice(0, keep)}… [${s.length - keep} cut]`);
    text = JSON.stringify(v);
  }
  return text.length <= max ? text : JSON.stringify({ cut: text.slice(0, max - 40) }).slice(0, max);
}

function setAt(v: unknown, path: (string | number)[], f: (s: string) => string): unknown {
  if (path.length === 0) return f(v as string);
  const [head, ...rest] = path as [string | number, ...(string | number)[]];
  if (Array.isArray(v)) return v.map((y, i) => (i === head ? setAt(y, rest, f) : y));
  const o = v as Record<string, unknown>;
  return { ...o, [head]: setAt(o[head], rest, f) };
}

// --- Building the prompt ------------------------------------------------------

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** One line: the Bash command, the edited path, the URL; else the tool and its input. */
export function summarize(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.length > 0);
  const main =
    tool === "Bash"
      ? pick("command")
      : (pick("file_path", "notebook_path", "path", "url", "query", "pattern") ??
        `${tool} ${JSON.stringify(input) ?? ""}`);
  return oneLine(redactText(main ?? tool), SUMMARY_MAX) || tool;
}

/**
 * The updates a phone may approve. Only allow rules and extra directories: a mode change
 * (`setMode`) or a deny rule reaches beyond the call at hand, so it stays at the keyboard.
 */
export function usableUpdates(suggestions: unknown[] | undefined): PermissionUpdate[] {
  const out: PermissionUpdate[] = [];
  for (const raw of suggestions ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as Record<string, unknown>;
    if (u.type === "addRules" && u.behavior === "allow" && Array.isArray(u.rules)) {
      const rules = u.rules.filter(
        (r): r is { toolName: string; ruleContent?: string } =>
          !!r &&
          typeof (r as { toolName?: unknown }).toolName === "string" &&
          ["string", "undefined"].includes(typeof (r as { ruleContent?: unknown }).ruleContent),
      );
      if (rules.length > 0) out.push({ type: "addRules", behavior: "allow", rules });
    } else if (u.type === "addDirectories" && Array.isArray(u.directories)) {
      const directories = u.directories.filter((d): d is string => typeof d === "string");
      if (directories.length > 0) out.push({ type: "addDirectories", directories });
    }
  }
  return out;
}

/** The exact rule text the owner sees for `updates`. */
export function ruleText(updates: PermissionUpdate[]): string {
  const parts = updates.flatMap((u) =>
    u.type === "addRules"
      ? (u.rules ?? []).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))
      : (u.directories ?? []).map((d) => `access to ${d}`),
  );
  return oneLine(redactText(parts.join(", ")), RULE_MAX);
}

/** Where Claude Code writes an update for each wider scope. */
const DESTINATION = { session: "session", project: "localSettings" } as const;

/** The `updatedPermissions` the hook returns for an allow with `scope`. */
export function updatesFor(
  updates: PermissionUpdate[],
  scope: PermissionScope,
): PermissionUpdate[] {
  if (scope === "once") return [];
  return updates.map((u) => ({ ...u, destination: DESTINATION[scope] }));
}

export function buildPermission(
  hook: PermissionHookInput,
  opts: {
    agent: Permission["agent"];
    source: PermissionSourceInput;
    machine: string;
    to: string[];
    now: Date;
    waitMs: number;
  },
): { permission: Permission; updates: PermissionUpdate[] } {
  const tool = typeof hook.tool_name === "string" ? hook.tool_name : "";
  if (!tool) throw new UsageError("the hook input has no tool_name");
  const raw = hook.tool_input ?? {};
  const updates = usableUpdates(hook.permission_suggestions);
  const rule = ruleText(updates);
  const project = opts.source.project;
  const description = (raw as { description?: unknown }).description;
  const ttl = Math.min(PERMISSION_TTL_MS, Math.max(1000, opts.waitMs));
  const permission = {
    v: 1 as const,
    id: `p_${randomBytes(12).toString("base64url")}`,
    to: opts.to,
    createdAt: iso(opts.now),
    agent: opts.agent,
    tool: tool.slice(0, 100),
    summary: summarize(tool, raw),
    ...(typeof description === "string" && description.trim()
      ? { description: oneLine(redactText(description), DESCRIPTION_MAX) }
      : {}),
    input: fitJson(redactValue(raw)),
    inputHash: hashInput(JSON.stringify(raw)),
    suggestions: rule
      ? [
          { label: "Allow for this session", rule, scope: "session" as const },
          {
            label: `Always allow in ${oneLine(project || "this project", 70)}`,
            rule,
            scope: "project" as const,
          },
        ]
      : [],
    expiresAt: iso(new Date(opts.now.getTime() + Math.floor(ttl / 1000) * 1000)),
    source: {
      machine: opts.machine,
      project: project.slice(0, 200),
      session: opts.source.session.slice(0, 200),
      ...(opts.source.sessionTitle ? { sessionTitle: opts.source.sessionTitle.slice(0, 200) } : {}),
      ...(opts.source.links?.length ? { links: opts.source.links } : {}),
    },
  };
  try {
    return { permission: parseWith(PermissionSchema, permission), updates };
  } catch (e) {
    throw e instanceof ProtocolError ? new UsageError(`bad permission: ${e.message}`) : e;
  }
}

/** Where the prompt comes from, from the hook input and Claude Code's record of the session. */
export function permissionSource(
  hook: PermissionHookInput,
  env: Ctx["env"],
): PermissionSourceInput {
  const session = typeof hook.session_id === "string" ? hook.session_id : "";
  const claude = session ? claudeSession(env, session) : undefined;
  return {
    project: basename(typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd()),
    session,
    ...(claude?.title ? { sessionTitle: claude.title } : {}),
    ...(claude?.links.length ? { links: claude.links } : {}),
  };
}

// --- Posting, answering, settling ---------------------------------------------

/** Drops prompts that ended a day ago. Call inside `updateState`. */
function prune(st: State, now: number) {
  for (const [id, p] of Object.entries(st.permissions ?? {}))
    if (Date.parse(p.permission.expiresAt) + KEEP_MS < now) delete st.permissions?.[id];
}

/**
 * Seals the prompt to every active device, posts it and records it as waiting. Returns its id.
 * The answers cursor is read before the post, so a wait from it never misses the answer.
 */
export async function postPermission(
  ctx: Ctx,
  s: Session,
  hook: PermissionHookInput,
  opts: { agent: Permission["agent"]; source: PermissionSourceInput; waitMs: number },
): Promise<string> {
  const dir = await refreshDirectory(ctx, s);
  const to = devices(dir);
  const { permission, updates } = buildPermission(hook, {
    ...opts,
    machine: s.machine.name,
    to: to.map((d) => d.id),
    now: ctx.now(),
  });
  const item = seal(
    "permission",
    permission,
    { id: s.machine.id, signKey: s.keys.sign.privateKey },
    to,
  );
  const cursor = ctx.store.state().cursor;
  ctx.store.updateState((st) => {
    prune(st, ctx.now().getTime());
    st.permissions ??= {};
    st.permissions[permission.id] = {
      permission,
      session: opts.source.session,
      updates,
      ...(cursor !== undefined ? { cursor } : {}),
    };
  });
  await s.api.postItem(item);
  return permission.id;
}

/**
 * Checks a permission answer item and records it on its waiting prompt. `open` checks that an
 * active device signed it; `checkPermissionAnswer` that it binds to this prompt. A prompt takes
 * one answer, and none once settled. Throws when the answer is refused.
 */
export function acceptPermissionAnswer(
  raw: unknown,
  s: Session,
  dir: Directory,
  st: State,
  now: number,
): { answer: PermissionAnswer; device: string } {
  const item = parseWith(SealedItem, raw);
  if (item.kind !== "permission-answer") throw new ProtocolError("wrong-kind", item.kind);
  const { body, signer } = open(
    item as SealedItem & { kind: "permission-answer" },
    { id: s.machine.id, box: s.keys.box },
    dir,
  );
  const pending = st.permissions?.[body.permissionId];
  if (!pending)
    throw new ProtocolError("unknown-member", `not my permission: ${body.permissionId}`);
  if (pending.answer || pending.settled)
    throw new ProtocolError("id-mismatch", `${body.permissionId} is no longer waiting`);
  checkPermissionAnswer(pending.permission, body, signer.id, now);
  return { answer: body, device: signer.id };
}

/** What a waiting hook needs to know: the accepted answer, or how the prompt ended. */
export interface PermissionOutcome {
  answer?: { behavior: "allow" | "deny"; scope: PermissionScope; message?: string };
  settled?: PendingPermission["settled"];
}

export function outcomeOf(p: PendingPermission | undefined): PermissionOutcome {
  if (!p) return { settled: "timeout" };
  if (p.answer)
    return {
      answer: {
        behavior: p.answer.behavior,
        scope: p.answer.scope,
        ...(p.answer.message !== undefined ? { message: p.answer.message } : {}),
      },
    };
  return p.settled ? { settled: p.settled } : {};
}

/** What Claude Code's `PermissionRequest` hook prints for an accepted answer. */
export function hookDecision(p: PendingPermission): unknown {
  const a = p.answer;
  if (!a) return undefined;
  const decision =
    a.behavior === "allow"
      ? {
          behavior: "allow",
          ...(a.scope !== "once" ? { updatedPermissions: updatesFor(p.updates, a.scope) } : {}),
        }
      : { behavior: "deny", ...(a.message ? { message: a.message } : {}) };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/**
 * Marks prompt `id` settled, if no one settled it yet, and returns what to tell the devices;
 * undefined when it was settled already. Synchronous, so a waiting hook marks its prompt before
 * it prints the answer and the `PostToolUse` that follows finds nothing left to settle.
 */
export function markSettled(
  ctx: Ctx,
  id: string,
  outcome: "keyboard" | "timeout" | "device",
): { outcome: Settled["outcome"]; device?: string } | undefined {
  let marked: { outcome: Settled["outcome"]; device?: string } | undefined;
  ctx.store.updateState((st) => {
    const p = st.permissions?.[id];
    if (!p || p.settled) return;
    p.settled = outcome;
    const device = outcome === "device" ? p.answer?.device : undefined;
    marked = { outcome, ...(device ? { device } : {}) };
  });
  return marked;
}

/** Tells the devices how prompt `id` ended. */
export async function postSettled(
  ctx: Ctx,
  s: Session,
  id: string,
  how: { outcome: Settled["outcome"]; device?: string },
): Promise<void> {
  const to = devices(await refreshDirectory(ctx, s));
  const body: Settled = {
    v: 1,
    id: `st_${randomBytes(12).toString("base64url")}`,
    itemId: id,
    to: to.map((d) => d.id),
    outcome: how.outcome,
    ...(how.device ? { device: how.device } : {}),
    at: iso(ctx.now()),
  };
  await s.api.postItem(
    seal("settled", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to),
  );
}

/** `markSettled`, then `postSettled`. False when it was settled already. */
export async function settle(
  ctx: Ctx,
  s: Session,
  id: string,
  outcome: "keyboard" | "timeout" | "device",
): Promise<boolean> {
  const how = markSettled(ctx, id, outcome);
  if (!how) return false;
  await postSettled(ctx, s, id, how);
  return true;
}

/**
 * The prompts of `session` still waiting that the keyboard settled: the one whose input hash is
 * `inputHash` when the hook names the call (a tool ran or was denied), else all of them (the
 * turn or the session ended).
 */
export function waitingFor(st: State, session: string, inputHash?: string): string[] {
  return Object.entries(st.permissions ?? {})
    .filter(
      ([, p]) =>
        p.session === session &&
        !p.settled &&
        (inputHash === undefined || p.permission.inputHash === inputHash),
    )
    .map(([id]) => id);
}

/** Whether permission prompts go to Starbridge on this machine (`starbridge permissions`). */
export function permissionsEnabled(ctx: Ctx): boolean {
  return ctx.store.agentConfig().permissions?.enabled === true;
}
