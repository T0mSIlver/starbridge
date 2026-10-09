/**
 * Permission prompts (#57): what `starbridge hook permission` posts when a coding agent stops at
 * a permission prompt, how the machine accepts a device's answer, and how a prompt is settled.
 * The agent and the CLI's own path (no agent) share this file and the state file.
 */
import { randomBytes } from "node:crypto";
import {
  checkPermissionAnswer,
  type Directory,
  hashInput,
  type MachineKind,
  type MemberKeys,
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
  visible,
} from "@starbridge/protocol";
import { claudeSession } from "./claude";
import type { PendingPermission, PermissionUpdate, State } from "./config";
import {
  type Ctx,
  devices,
  iso,
  machineKind,
  refreshDirectory,
  type Session,
  signedHead,
  UsageError,
} from "./context";
import { OPENCODE_TITLE } from "./opencode";
import { piSessionTitle } from "./pi";
import { projectName } from "./project";

/**
 * What Claude Code's `PermissionRequest` hook gets on stdin (fields Starbridge reads). The Pi
 * extension sends the same shape, with Pi's tool names (`bash`) and no suggestions.
 */
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

/**
 * What a redacted span may hold: one token, without whitespace, quotes, `$`, backticks, brackets
 * or shell operators. A span outside it stays visible, because a device's allow approves what it
 * shows: `X_TOKEN="$(curl … | sh)"` must not read as `X_TOKEN=[redacted]`.
 */
const TOKEN = "[A-Za-z0-9_+/=.~:@%!#*^-]";

/** Token shapes of common providers, after Claude Code 2.1.234's list. */
const SECRET_PATTERNS: RegExp[] = [
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

/** A private key's opening line: a Bash command holding one never goes to devices. */
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * A PEM private key's body after its opening line: `Name: value` headers (an encrypted key's
 * `Proc-Type`, `DEK-Info`), which stay, and base64 lines, which go, with or without the END line.
 * Each line may start with a diff's `+`, `-` or space, as in an opencode edit's diff (#489).
 */
const PEM_BODY =
  /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)((?:\r?\n[-+ ]?(?:[A-Za-z-]+:[^\r\n]*|[A-Za-z0-9+/=]*[ \t]*)(?=\r?\n|$))*)/g;
const PEM_HEADER = /\r?\n[-+ ]?[A-Za-z-]+:[^\r\n]*/g;

/** A name whose value is a secret: `FOO_KEY`, `GITHUB_TOKEN`, `password`. */
const SECRET_NAME = /^[A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_-]*$/i;

/**
 * `FOO_KEY=…`, `GITHUB_TOKEN: …`, `API_KEY = '…'`, `--password=…`: the value goes when it is one
 * token, quoted or not. An `=` takes no space after it unless it has one before, since
 * `X_KEY= cmd` runs `cmd`. A single-quoted value ends at the next quote, as in the shell.
 */
const ASSIGNMENT = new RegExp(
  `\\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)(\\s*:\\s*|\\s+=\\s*|=)("${TOKEN}*"|'${TOKEN}*'|${TOKEN}+)`,
  "gi",
);

/** `Authorization: <scheme> …` and its proxy twin: the credential goes, the scheme stays. */
const AUTH_HEADER = new RegExp(
  `\\b((?:Proxy-)?Authorization\\s*:\\s*(?:[A-Za-z-]+\\s+)?)${TOKEN}+`,
  "gi",
);

/** The password in a URL's userinfo, `https://user:pass@host`. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9_.~%!*+-]*:)[A-Za-z0-9_.~%!*+=,-]+@/gi;

/** Removes secrets from one string. */
export function redactText(text: string): string {
  let out = text.replace(PEM_BODY, (all: string, begin: string, body: string) => {
    const headers = (body.match(PEM_HEADER) ?? []).join("");
    // A BEGIN line with no base64 after it is only text about a key.
    return /[A-Za-z0-9+/=]/.test(body.replace(PEM_HEADER, ""))
      ? `${begin}${headers}\n${REDACTED}`
      : all;
  });
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  return out
    .replace(AUTH_HEADER, (_, head: string) => `${head}${REDACTED}`)
    .replace(URL_PASSWORD, (_, head: string) => `${head}${REDACTED}@`)
    .replace(ASSIGNMENT, (_, name: string, sep: string) => `${name}${sep}${REDACTED}`);
}

/**
 * An object from `entries` whose keys were rewritten (redacted, escaped). Throws when two keys now
 * read alike: devices would see one value for both, while the hash covers the input as received.
 */
function uniqueKeys(entries: (readonly [string, unknown])[]): Record<string, unknown> {
  if (new Set(entries.map(([k]) => k)).size < entries.length)
    throw new UsageError("the input has keys that read alike: it stays at the keyboard");
  return Object.fromEntries(entries);
}

/** Redacts every string in a JSON value, keys included, and a token under a secret's name. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object")
    return uniqueKeys(
      Object.entries(value).map(([k, v]) => [
        redactText(k),
        SECRET_NAME.test(k) && typeof v === "string" && new RegExp(`^${TOKEN}+$`).test(v)
          ? REDACTED
          : redactValue(v),
      ]),
    );
  return value;
}

/** JSON text of `value` within `max` characters: the longest strings are cut until it fits. */
export function fitJson(value: unknown, max = INPUT_MAX): string {
  let v = visibleValue(value);
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
  if (text.length <= max) return text;
  // Many short strings, or none: keep the start as one string, cut until it fits as JSON.
  let keep = max;
  let out = JSON.stringify({ cut: text.slice(0, keep) });
  while (out.length > max) {
    keep -= out.length - max + 1;
    out = JSON.stringify({ cut: text.slice(0, keep) });
  }
  return out;
}

/**
 * Every string in a JSON value, keys included, through `visible`. Throws when two keys read alike
 * once escaped (`x` + U+202E and `x\\u202E`).
 */
function visibleValue(value: unknown): unknown {
  if (typeof value === "string") return visible(value);
  if (Array.isArray(value)) return value.map(visibleValue);
  if (value && typeof value === "object")
    return uniqueKeys(
      Object.entries(value).map(([k, v]) => [visible(k), visibleValue(v)] as const),
    );
  return value;
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
  const flat = visible(s.replace(/\s+/g, " ").trim());
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** Claude Code's and Codex's shell tool, or Pi's. */
const isShell = (tool: string) => tool === "Bash" || tool === "bash";

/** The files a Codex `apply_patch` touches, from its `*** Update File: <path>` lines. */
function patchFiles(patch: string): string | undefined {
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]);
  return files.length > 0 ? files.join(", ") : undefined;
}

/**
 * One line: the Bash command, the edited path or a Codex patch's files, the URL; else the tool
 * and its input. `input` is redacted already (`redactValue`).
 */
export function summarize(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.length > 0);
  const main = isShell(tool)
    ? pick("command")
    : ((tool === "apply_patch" ? patchFiles(pick("command") ?? "") : undefined) ??
      pick("file_path", "notebook_path", "path", "url", "query", "pattern", "preview") ??
      `${tool} ${JSON.stringify(input) ?? ""}`);
  return oneLine(main ?? tool, SUMMARY_MAX) || tool;
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

/**
 * The exact rule text the owner sees for `updates`, or "" when it does not show in full: a wider
 * scope applies every rule, so it is offered only when the owner can read them all, secrets
 * included.
 */
export function ruleText(updates: PermissionUpdate[]): string {
  const parts = updates.flatMap((u) =>
    u.type === "addRules"
      ? (u.rules ?? []).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))
      : (u.directories ?? []).map((d) => `access to ${d}`),
  );
  const text = visible(parts.join(", ").replace(/\s+/g, " ").trim());
  return text.length <= RULE_MAX && redactText(text) === text ? text : "";
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

/** The `inputHash` of a call's input, keyed under the machine's signing key. */
export function inputHashOf(keys: MemberKeys, input: unknown): string {
  return hashInput(JSON.stringify(input), keys.sign.privateKey);
}

export function buildPermission(
  hook: PermissionHookInput,
  opts: {
    agent: Permission["agent"];
    source: PermissionSourceInput;
    machine: string;
    machineKind?: MachineKind;
    keys: MemberKeys;
    to: string[];
    now: Date;
    waitMs: number;
  },
): { permission: Permission; updates: PermissionUpdate[] } {
  const tool = typeof hook.tool_name === "string" ? hook.tool_name : "";
  if (!tool) throw new UsageError("the hook input has no tool_name");
  const raw = hook.tool_input ?? {};
  // Hiding the key would hide the lines around it from the owner, and showing it leaks it.
  if (isShell(tool) && PRIVATE_KEY.test(JSON.stringify(raw)))
    throw new UsageError("the command holds a private key: it stays at the keyboard");
  const updates = usableUpdates(hook.permission_suggestions);
  const rule = ruleText(updates);
  const project = opts.source.project;
  // The summary and description come from the redacted input too: key-name redaction is
  // `redactValue`'s alone.
  const safe = redactValue(raw);
  const description = (safe as { description?: unknown }).description;
  const ttl = Math.min(PERMISSION_TTL_MS, Math.max(1000, opts.waitMs));
  const permission = {
    v: 1 as const,
    id: `p_${randomBytes(12).toString("base64url")}`,
    to: opts.to,
    createdAt: iso(opts.now),
    agent: opts.agent,
    tool: tool.slice(0, 100),
    summary: summarize(tool, safe),
    ...(typeof description === "string" && description.trim()
      ? { description: oneLine(description, DESCRIPTION_MAX) }
      : {}),
    input: fitJson(safe),
    inputHash: inputHashOf(opts.keys, raw),
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
      ...(opts.machineKind ? { machineKind: opts.machineKind } : {}),
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

/**
 * Where the prompt comes from, from the hook input and Claude Code's record of the session, the
 * name in Pi's session file (`PI_SESSION_FILE`, which the Pi extension passes), or the title the
 * opencode plugin passes.
 */
export function permissionSource(
  hook: PermissionHookInput,
  env: Ctx["env"],
): PermissionSourceInput {
  const session = typeof hook.session_id === "string" ? hook.session_id : "";
  const claude = session ? claudeSession(env, session) : undefined;
  const title =
    claude?.title ?? piSessionTitle(env) ?? (env[OPENCODE_TITLE]?.slice(0, 200) || undefined);
  return {
    project: projectName(typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd()),
    session,
    ...(title ? { sessionTitle: title } : {}),
    ...(claude?.links.length ? { links: claude.links } : {}),
  };
}

// --- Posting, answering, settling ---------------------------------------------

/** Drops prompts that ended a day ago. Call inside `updateState`. */
function prune(st: State, now: number) {
  for (const [id, p] of Object.entries(st.permissions ?? {}))
    if (Date.parse(p.permission.expiresAt) + KEEP_MS < now) delete st.permissions?.[id];
}

/** How long a prompt whose post was cut may take to report itself settled. */
const LATE_REPORT_MS = 5_000;

/**
 * Seals the prompt to every active device, posts it and records it as waiting. Returns its id.
 * The answers cursor is read before the post, so a wait from it never misses the answer.
 * `signal` cuts the requests: the hook's deadline, or the keyboard answering.
 */
export async function postPermission(
  ctx: Ctx,
  s: Session,
  hook: PermissionHookInput,
  opts: { agent: Permission["agent"]; source: PermissionSourceInput; waitMs: number },
  signal?: AbortSignal,
): Promise<string> {
  const dir = await refreshDirectory(ctx, s, signal);
  const to = devices(ctx, dir);
  const { permission, updates } = buildPermission(hook, {
    ...opts,
    machine: s.machine.name,
    ...machineKind(ctx),
    keys: s.keys,
    to: to.map((d) => d.id),
    now: ctx.now(),
  });
  const item = seal(
    "permission",
    { ...permission, dir: signedHead(dir) },
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
  try {
    await s.api.postItem(item, signal);
  } catch (e) {
    // No hook waits for it now: nothing may apply an answer that still comes.
    const keyboard = signal?.aborted && (signal.reason as Error)?.name !== "TimeoutError";
    const how = markSettled(ctx, permission.id, keyboard ? "keyboard" : "timeout");
    // The server may have stored the prompt before the cut (#900): tell the devices it is over,
    // or it stays open there. A server that never got it refuses this, which changes nothing.
    if (how)
      await postSettled(ctx, s, permission.id, how, AbortSignal.timeout(LATE_REPORT_MS)).catch(
        () => {},
      );
    throw e;
  }
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
  // Settled wins: an answer that arrived after the keyboard settled it is never applied.
  if (p.settled) return { settled: p.settled };
  if (p.answer)
    return {
      answer: {
        behavior: p.answer.behavior,
        scope: p.answer.scope,
        ...(p.answer.message !== undefined ? { message: p.answer.message } : {}),
      },
    };
  return {};
}

/**
 * Sent with a deny that carries no message. Without one Claude Code tells the agent "Permission
 * denied by hook", which reads as a misconfigured hook rather than the owner's choice.
 */
export const DENIED = "The owner denied this on their phone or browser, through Starbridge.";

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
      : { behavior: "deny", message: a.message || DENIED };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/** How a prompt ended, as its settled notice tells the devices. */
type Settling = Pick<Settled, "outcome" | "device" | "behavior">;

/**
 * Marks prompt `id` settled, if no one settled it yet, and returns what to tell the devices;
 * undefined when it was settled already. Synchronous, so a waiting hook marks its prompt before
 * it prints the answer and the `PostToolUse` that follows finds nothing left to settle.
 */
export function markSettled(
  ctx: Ctx,
  id: string,
  outcome: "keyboard" | "timeout" | "device",
): Settling | undefined {
  let marked: Settling | undefined;
  ctx.store.updateState((st) => {
    const p = st.permissions?.[id];
    if (!p || p.settled) return;
    p.settled = outcome;
    const a = outcome === "device" ? p.answer : undefined;
    marked = { outcome, ...(a ? { device: a.device, behavior: a.behavior } : {}) };
  });
  return marked;
}

/** Tells the devices how prompt `id` ended. `signal` cuts the requests. */
export async function postSettled(
  ctx: Ctx,
  s: Session,
  id: string,
  how: Settling,
  signal?: AbortSignal,
): Promise<void> {
  const dir = await refreshDirectory(ctx, s, signal);
  const to = devices(ctx, dir);
  const body: Settled = {
    v: 1,
    id: `st_${randomBytes(12).toString("base64url")}`,
    itemId: id,
    to: to.map((d) => d.id),
    outcome: how.outcome,
    ...(how.device ? { device: how.device, behavior: how.behavior } : {}),
    at: iso(ctx.now()),
    dir: signedHead(dir),
  };
  await s.api.postItem(
    seal("settled", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to),
    signal,
  );
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
