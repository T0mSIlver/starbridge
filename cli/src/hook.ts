/**
 * The commands Claude Code's and Codex's hooks run (#57, #950). `hook permission` runs on
 * `PermissionRequest`: it posts the prompt, waits for a device's answer and prints it as the
 * hook's decision. `hook settle` runs on `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`,
 * `Stop` and `SessionEnd` (Codex: `Stop` and `Interrupt`): the keyboard or the Claude app
 * answered, so the waiting prompt is settled and its hook lets go.
 *
 * Neither ever allows anything by itself: on any error, timeout or lost network they print
 * nothing and exit 0, and Claude Code's own dialog decides. `hook permission` on Claude Code's
 * `AskUserQuestion` and `hook question` do the same for questions asked in the terminal, Claude
 * Code's and opencode's: they race the picker (#848).
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Answer, type Permission, ProtocolError } from "@starbridge/protocol";
import type { SessionEvent } from "./agent/api";
import { MAX_HOLD_SECONDS } from "./agent/api";
import { type AgentClient, Interrupted, withAgent } from "./agent/client";
import type { PermissionPosted, PermissionWait } from "./agent/permissions";
import type { State } from "./config";
import { type Ctx, parseDuration, session, UsageError } from "./context";
import { cursorAgentArgs } from "./cursor";
import {
  type AskInput,
  ackLines,
  ask,
  deliveryLine,
  dropRevokedNow,
  EXIT_SNOOZED,
  poll,
  postDecision,
  resolveSource,
  sessionLines,
  settle,
  wait,
} from "./decisions";
import {
  DEFAULT_WAIT_MS,
  hookDecision,
  inputHashOf,
  markSettled,
  type PermissionHookInput,
  permissionSource,
  permissionsEnabled,
  postPermission,
  postSettled,
  waitingFor,
} from "./permissions";
import { projectName } from "./project";
import { untilRan } from "./ran";

/** Slack past a held request's `wait` before the hook gives up on the agent. */
const SLACK_MS = 15_000;
/** How long the hook's own path holds each answer poll, so it sees a settle soon. */
const DIRECT_POLL_SECONDS = 5;
/** How long reporting a prompt settled may hold up the hook's own path. */
const REPORT_MS = 5_000;

function parseHook(text: string): PermissionHookInput & Record<string, unknown> {
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object") throw new UsageError("the hook input is not a JSON object");
  return v as PermissionHookInput & Record<string, unknown>;
}

/**
 * Whether Cursor runs this hook: cursor-agent runs installed Claude Code plugins' hooks too, with
 * its own input (#958). The Claude Code plugin's hooks then step aside for setup's Cursor hooks.
 */
function inCursor(hook: Record<string, unknown>): boolean {
  return typeof hook.cursor_version === "string";
}

function agentName(text: string | undefined): Permission["agent"] {
  // Pi asks through the Starbridge Pi extension's link in pi-permission-system (#232), opencode
  // through the Starbridge opencode plugin (#300), Codex through the Starbridge Codex plugin.
  if (text === "claude-code" || text === "codex" || text === "pi" || text === "opencode")
    return text;
  throw new UsageError(`--agent: claude-code, codex, pi or opencode (got ${text ?? "nothing"})`);
}

/** How often the hook checks that the agent that ran it is still there. */
const PARENT_CHECK_MS = 2_000;

/**
 * `signal`, also aborted once the hook's parent is gone: an agent killed outright leaves it
 * orphaned, holding a prompt whose answer nobody would apply.
 */
export function untilOrphaned(
  signal: AbortSignal | undefined,
  ppid: () => number = () => process.ppid,
): { signal: AbortSignal; stop: () => void } {
  const parent = ppid();
  const orphaned = new AbortController();
  const timer = setInterval(() => {
    if (ppid() !== parent) orphaned.abort();
  }, PARENT_CHECK_MS);
  timer.unref();
  return {
    signal: signal ? AbortSignal.any([signal, orphaned.signal]) : orphaned.signal,
    stop: () => clearInterval(timer),
  };
}

/**
 * `starbridge hook permission --agent claude-code [--wait 570s]`, hook JSON on stdin. `ran`
 * watches for a Bash call starting, which means the keyboard allowed it (#866).
 */
export async function hookPermission(
  outer: Ctx,
  stdin: string,
  opts: { agent?: string; wait?: string },
  ran: typeof untilRan = untilRan,
): Promise<number> {
  const watch = untilOrphaned(outer.signal);
  let ctx = { ...outer, signal: watch.signal };
  let started: ReturnType<typeof untilRan> | undefined;
  try {
    const hook = parseHook(stdin);
    if (opts.agent === "claude-code" && inCursor(hook)) return 0;
    // Its picker is a permission dialog, raced whether or not permission prompts go to the devices.
    if (hook.tool_name === "AskUserQuestion" && opts.agent === "claude-code")
      return await racePicker(ctx, outer, hook, opts.wait);
    if (!permissionsEnabled(ctx)) return 0;
    const agent = agentName(opts.agent);
    // Claude Code tells the hook nothing when the keyboard allows the call; the call starting
    // settles the prompt as SIGTERM does, rather than PostToolUse once it ends.
    const command = (hook.tool_input as { command?: unknown } | undefined)?.command;
    if (agent === "claude-code" && hook.tool_name === "Bash" && typeof command === "string") {
      started = ran(ctx.signal, command);
      ctx = { ...ctx, signal: started.signal };
    }
    const waitMs = opts.wait ? parseDuration(opts.wait) : DEFAULT_WAIT_MS;
    const deadline = ctx.now().getTime() + waitMs;
    const source = permissionSource(hook, ctx.env);
    // Codex opens its dialog only once the hook returns without a decision, so the hook cannot
    // race it: it hands over to the keyboard while the owner sits at this machine, which only
    // the agent knows (#950). Without the agent it holds for the devices until the deadline.
    const handOver = agent === "codex";
    const output = await withAgent(
      ctx,
      (a) => viaAgent(ctx, a, { hook, agent, source, waitMs, handOver }, deadline),
      () => direct(ctx, { hook, agent, source, waitMs }, deadline),
    );
    if (output !== undefined) ctx.out(JSON.stringify(output));
  } catch (e) {
    ctx.err(`starbridge: permission prompt not sent: ${(e as Error).message}`);
  } finally {
    started?.stop();
    watch.stop();
  }
  return 0;
}

type Ask = Parameters<typeof postPermission>[3] & {
  hook: PermissionHookInput;
  /** Codex: the keyboard takes the prompt once the owner sits at this machine. */
  handOver?: boolean;
};

async function viaAgent(
  ctx: Ctx,
  agent: AgentClient,
  ask: Ask,
  deadline: number,
): Promise<unknown> {
  let id: string;
  try {
    const posted = await agent.call<PermissionPosted>(
      "POST",
      "/v1/permissions",
      ask,
      Math.max(1, deadline - ctx.now().getTime()),
      ctx.signal,
    );
    // The owner sits at this machine: nothing was posted, and the dialog opens.
    if (!posted.id) return undefined;
    id = posted.id;
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    // The keyboard answered while the prompt was being posted: settle it by its call.
    const inputHash = inputHashOf(session(ctx).keys, ask.hook.tool_input ?? {});
    const sessionPath = encodeURIComponent(ask.source.session);
    await agent.call(
      "POST",
      `/v1/sessions/${sessionPath}/permissions/settle`,
      { inputHash },
      5_000,
    );
    return undefined;
  }
  const path = `/v1/permissions/${encodeURIComponent(id)}`;
  try {
    while (true) {
      const left = deadline - ctx.now().getTime();
      if (left <= 0) break;
      const wait = Math.max(1, Math.min(MAX_HOLD_SECONDS, Math.ceil(left / 1000)));
      const r = await agent.call<PermissionWait>(
        "POST",
        `${path}/wait`,
        { wait, ...(ask.handOver ? { handOver: true } : {}) },
        wait * 1000 + SLACK_MS,
        ctx.signal,
      );
      if (r.output !== undefined) return r.output;
      if (r.settled) return undefined;
    }
    await agent.call("POST", `${path}/settle`, { outcome: "timeout" }, 5_000);
  } catch (e) {
    // Claude Code sends SIGTERM when the keyboard answers Esc or No; a Yes starts the call (#866).
    // Codex kills the hook when the turn is interrupted, and the agent settles the prompt then.
    if (!(e instanceof Interrupted)) throw e;
    await agent.call("POST", `${path}/settle`, { outcome: "keyboard" }, 5_000);
  }
  return undefined;
}

/** The hook's own path when no agent runs: post, then poll the server itself. */
async function direct(ctx: Ctx, ask: Ask, deadline: number): Promise<unknown> {
  const s = session(ctx);
  /** Cuts a request at SIGTERM or the deadline, so a stalled server never holds the hook. */
  const cut = () => {
    const left = AbortSignal.timeout(Math.max(1, deadline - ctx.now().getTime()));
    return ctx.signal ? AbortSignal.any([ctx.signal, left]) : left;
  };
  const id = await postPermission(ctx, s, ask.hook, ask, cut());
  let cursor = ctx.store.state().permissions?.[id]?.cursor;
  let directory: Awaited<ReturnType<typeof poll>>["directory"] | undefined;
  /** Marks the prompt settled and reports it, giving up after `REPORT_MS` or on `signal`. */
  const settle = async (outcome: "keyboard" | "timeout" | "device", signal?: AbortSignal) => {
    const how = markSettled(ctx, id, outcome);
    if (!how) return false;
    const cut = AbortSignal.timeout(REPORT_MS);
    await postSettled(ctx, s, id, how, signal ? AbortSignal.any([signal, cut]) : cut).catch((e) =>
      ctx.err(`starbridge: could not report the prompt settled: ${(e as Error).message}`),
    );
    return true;
  };
  const ended = () => ctx.signal?.aborted || ctx.now().getTime() >= deadline;
  while (true) {
    const p = ctx.store.state().permissions?.[id];
    if (!p || p.settled) return undefined;
    // SIGTERM (Esc or No at the keyboard) or the call starting (Yes, #866); a later answer is dropped.
    if (ctx.signal?.aborted) {
      await settle("keyboard");
      return undefined;
    }
    const left = deadline - ctx.now().getTime();
    if (left <= 0) {
      await settle("timeout");
      return undefined;
    }
    // Behind on the directory, the answer may be a revoked device's: it waits.
    if (p.answer && !ctx.store.state().behind) {
      // Reporting may not outlive the hook: SIGTERM or the deadline still end it with no answer.
      const cut = AbortSignal.timeout(left);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, cut]) : cut;
      if (!(await settle("device", signal)) || ended()) return undefined;
      return hookDecision(p);
    }
    try {
      const seconds = Math.max(1, Math.min(DIRECT_POLL_SECONDS, Math.ceil(left / 1000)));
      ({ cursor, directory } = await poll({ ...ctx, signal: cut() }, s, {
        cursor,
        seconds,
        shared: false,
        ...(directory ? { directory } : {}),
      }));
    } catch (e) {
      if (ctx.signal?.aborted) continue;
      if (e instanceof UsageError) throw e;
      ctx.err(`starbridge: ${(e as Error).message}; retrying`);
      await ctx.sleep(Math.min(2_000, Math.max(0, left)));
    }
  }
}

/** `starbridge hook settle --agent claude-code|codex`, hook JSON on stdin. */
export async function hookSettle(
  ctx: Ctx,
  stdin: string,
  opts: { agent?: string },
): Promise<number> {
  try {
    agentName(opts.agent);
    const hook = parseHook(stdin);
    if (opts.agent === "claude-code" && inCursor(hook)) return 0;
    const sessionId = typeof hook.session_id === "string" ? hook.session_id : "";
    // Runs after a tool call while a prompt is open: nothing waiting for this session means no
    // network and no agent call. A mark that disagrees with the state (an expired prompt, a state
    // a new pairing replaced) is fixed under the lock.
    const st = ctx.store.state();
    if (ctx.store.promptsMarkStale(st)) ctx.store.updateState(() => {});
    if (!sessionId) return 0;
    // The picker was answered or dismissed in Claude Code, or the turn ended: its questions are
    // moot on the devices. A device's answer to it got there first and is no longer open.
    if (hook.tool_name === "AskUserQuestion" || hook.tool_input === undefined)
      await settlePicker(ctx, sessionId, "elsewhere");
    if (waitingFor(ctx.store.state(), sessionId).length === 0) return 0;
    // A tool that ran or was denied names its call; the end of a turn or session settles all.
    const inputHash =
      hook.tool_input !== undefined ? inputHashOf(session(ctx).keys, hook.tool_input) : undefined;
    if (waitingFor(ctx.store.state(), sessionId, inputHash).length === 0) return 0;
    await withAgent(
      ctx,
      (a) =>
        a.call(
          "POST",
          `/v1/sessions/${encodeURIComponent(sessionId)}/permissions/settle`,
          inputHash ? { inputHash } : {},
        ),
      async () => {
        const s = session(ctx);
        // Every prompt is settled locally first, so a failed report leaves none of them waiting.
        const settled = waitingFor(ctx.store.state(), sessionId, inputHash).flatMap((id) => {
          const how = markSettled(ctx, id, "keyboard");
          return how ? [{ id, how }] : [];
        });
        for (const { id, how } of settled)
          await postSettled(ctx, s, id, how, AbortSignal.timeout(REPORT_MS)).catch((e) =>
            ctx.err(`starbridge: could not report ${id} settled: ${(e as Error).message}`),
          );
      },
    );
  } catch (e) {
    ctx.err(`starbridge: could not settle the permission prompt: ${(e as Error).message}`);
  }
  return 0;
}

/** One question of Claude Code's `AskUserQuestion`, as its tool input carries it. */
interface PickerQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

function pickerQuestions(input: unknown): PickerQuestion[] | undefined {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    !questions.every((q) => typeof (q as { question?: unknown })?.question === "string")
  )
    return undefined;
  return questions as PickerQuestion[];
}

/** The picker's open questions on this machine's devices, by the session that asked them. */
export function pickerOpen(st: ReturnType<Ctx["store"]["state"]>, session: string): string[] {
  return Object.entries(st.asked)
    .filter(([id, a]) => a.picker === session && !a.settled && !st.answers[id])
    .map(([id]) => id);
}

async function settlePicker(ctx: Ctx, session: string, outcome: "elsewhere" | "withdrawn") {
  await Promise.all(
    pickerOpen(ctx.store.state(), session).map((id) =>
      settle({ ...ctx, signal: undefined }, { id, outcome }).catch((e) =>
        ctx.err(`starbridge: could not settle ${id}: ${(e as Error).message}`),
      ),
    ),
  );
}

/**
 * Claude Code's `AskUserQuestion` (#848), on `PermissionRequest` while its picker is open in the
 * terminal, the desktop app or the Claude app. Each of its questions becomes a decision on the
 * devices, already waiting and held from the session's answer loop. Once every one has a
 * device's answer, it prints them as the picker's answers, which closes the picker. Claude Code
 * says nothing to the hook when the picker is answered there: `hook settle` on `PostToolUse`
 * settles the decisions. Esc and Claude Code's own hook timeout both send SIGTERM, so the hook
 * stops itself at `wait`, before that timeout, and withdraws its questions: their answers could
 * no longer reach the picker.
 */
async function racePicker(
  ctx: Ctx,
  outer: Ctx,
  hook: PermissionHookInput & Record<string, unknown>,
  waitText: string | undefined,
): Promise<number> {
  const questions = pickerQuestions(hook.tool_input);
  const sessionId = typeof hook.session_id === "string" ? hook.session_id : "";
  if (!questions || !sessionId) return 0;
  const s = session(ctx);
  const waitMs = waitText ? parseDuration(waitText) : DEFAULT_WAIT_MS;
  const cwd = typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd();
  const deadline = AbortSignal.timeout(waitMs);
  // One question that cannot be asked stops the others: the picker takes all answers or none.
  const failed = new AbortController();
  const signal = AbortSignal.any([
    ctx.signal ?? new AbortController().signal,
    deadline,
    failed.signal,
  ]);
  const results = await Promise.allSettled(
    questions.map(async (q) => {
      const sub: Ctx = { ...ctx, signal, err: () => {} };
      const input: AskInput = {
        ...questionInput({ ...q, multiple: q.multiSelect }),
        agent: "claude-code",
        session: sessionId,
        project: projectName(cwd),
        held: true,
        picker: sessionId,
        waiting: true,
      };
      let id: string;
      try {
        ({ id } = await postDecision(sub, s, resolveSource(input, ctx.env, cwd)));
      } catch (e) {
        failed.abort();
        throw e;
      }
      // A snooze puts it off on the devices; the picker still waits for an answer.
      while (true) {
        const lines: string[] = [];
        const code = await wait(
          { ...sub, out: (l) => lines.push(l) },
          { id, json: true, "no-mark": true },
          s,
        );
        if (code === 0 && lines[0])
          return opencodeAnswer(JSON.parse(lines[0]) as Answer, { ...q, multiple: q.multiSelect });
        if (code !== EXIT_SNOOZED) return undefined;
      }
    }),
  );
  const picked = results.map((r) => (r.status === "fulfilled" ? r.value : undefined));
  const error = results.find((r) => r.status === "rejected");
  if (error && !signal.aborted)
    ctx.err(`starbridge: question not sent: ${(error.reason as Error).message}`);
  if (picked.every((p) => p !== undefined) && !signal.aborted) {
    const answers = Object.fromEntries(
      questions.map((q, i) => [q.question, (picked[i] as string[]).join(", ")]),
    );
    const decision = {
      behavior: "allow",
      updatedInput: { ...(hook.tool_input as object), answers },
    };
    ctx.out(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }),
    );
    return 0;
  }
  // SIGTERM: Esc at the picker (or Claude Code's timeout, which `wait` comes before). Otherwise
  // the hook's own time ran out or a question could not be asked: no answer reaches the picker.
  await settlePicker(ctx, sessionId, outer.signal?.aborted ? "elsewhere" : "withdrawn");
  return 0;
}

/**
 * `starbridge hook ask-user`, on `PreToolUse` for `AskUserQuestion`, from plugins before #848:
 * prints nothing, so the picker opens and `hook permission` races it. Those plugins sent the
 * agent to `starbridge ask` instead; plugins since keep the entry one release, so an older CLI
 * under a newer plugin still does that rather than leave the picker to `hook permission`, which
 * took it for a permission prompt.
 */
export function hookAskUser(): number {
  return 0;
}

/** One question of opencode's `question` tool, as its `question.asked` event carries it. */
export interface OpencodeQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiple?: boolean;
  custom?: boolean;
}

/** What the plugin hands `hook question` on stdin. */
export interface QuestionHookInput {
  session_id: string;
  cwd: string;
  questions: OpencodeQuestion[];
}

/** Limits of a decision (PROTOCOL.md): its question, context, options and each option. */
const QUESTION_CHARS = 300;
const CONTEXT_CHARS = 8000;
const MAX_OPTIONS = 4;
const OPTION_CHARS = 100;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The decision for one question. Its labels become the options, so a tap answers with the label
 * opencode expects; the agent marks its pick "(Recommended)" and puts it first. A question a
 * decision cannot offer as taps (more than 4 options, a label too long, one option) lists them
 * in the context and takes a typed reply.
 */
export function questionInput(q: OpencodeQuestion): AskInput {
  const labels = (q.options ?? []).map((o) => o.label);
  const taps =
    labels.length >= 2 &&
    labels.length <= MAX_OPTIONS &&
    new Set(labels).size === labels.length &&
    labels.every((l) => l.length > 0 && l.length <= OPTION_CHARS);
  const lines = [
    ...(q.question.length > QUESTION_CHARS ? [q.question, ""] : []),
    ...(q.options ?? []).map((o) =>
      o.description ? `- ${o.label}: ${o.description}` : `- ${o.label}`,
    ),
    ...(q.multiple ? ["", "More than one can apply: reply with each one you pick."] : []),
  ];
  const recommended = labels.find((l) => /\(recommended\)\s*$/i.test(l));
  return {
    question: clip(q.question, QUESTION_CHARS),
    context: clip(lines.join("\n").trim(), CONTEXT_CHARS),
    ...(taps ? { options: labels, ...(recommended ? { recommended } : {}) } : {}),
  };
}

/**
 * opencode's answer to one question: the label tapped, or the owner's own words. For a question
 * that takes several, a reply that names only its labels, split on commas or lines, is those.
 */
export function opencodeAnswer(a: Answer, q: OpencodeQuestion): string[] {
  if (a.choice !== undefined) return [a.choice];
  const text = a.text ?? "";
  const labels = new Set((q.options ?? []).map((o) => o.label));
  const parts = text
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return q.multiple && parts.length > 0 && parts.every((p) => labels.has(p)) ? parts : [text];
}

/**
 * `starbridge hook question --agent opencode`, the plugin's input on stdin: posts each question
 * of one `question` tool call as a decision, already waiting, and once all are answered prints
 * `{"answers": [[label], ...]}` for opencode's reply route. Nothing else gets those answers: they
 * are `held`, recorded without the session, whose answer loop would submit them as a prompt; so
 * it goes to the server itself.
 * SIGTERM means the terminal answered or dismissed the call: the questions still open are
 * settled as answered elsewhere. Any error prints nothing, and the terminal's dialog decides.
 */
export async function hookQuestion(
  outer: Ctx,
  stdin: string,
  opts: { agent?: string },
): Promise<number> {
  // opencode killed outright never sends SIGTERM: the questions would wait for nobody.
  const watch = untilOrphaned(outer.signal);
  const ctx = { ...outer, signal: watch.signal };
  try {
    if (opts.agent !== "opencode")
      throw new UsageError(`--agent: opencode (got ${opts.agent ?? "nothing"})`);
    const hook = JSON.parse(stdin) as QuestionHookInput;
    if (!Array.isArray(hook?.questions) || hook.questions.length === 0 || !hook.session_id)
      throw new UsageError("the hook input needs session_id and questions");
    session(ctx);
    // One question that cannot be asked stops the others: opencode takes all answers or none.
    const failed = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, failed.signal]) : failed.signal;
    const ids: (string | undefined)[] = [];
    const results = await Promise.allSettled(
      hook.questions.map(async (q, i) => {
        const lines: string[] = [];
        const sub: Ctx = { ...ctx, signal, out: (l) => lines.push(l), err: () => {} };
        const input: AskInput = {
          ...questionInput(q),
          agent: "opencode",
          session: hook.session_id,
          project: projectName(hook.cwd || process.cwd()),
          held: true,
        };
        const how = { wait: true, json: true };
        try {
          const code = await ask(sub, input, how);
          ids[i] = lines[0];
          return code === 0 && lines[1]
            ? opencodeAnswer(JSON.parse(lines[1]) as Answer, q)
            : undefined;
        } catch (e) {
          ids[i] = lines[0];
          failed.abort();
          throw e;
        }
      }),
    );
    const picked = results.map((r) => (r.status === "fulfilled" ? r.value : undefined));
    const error = results.find((r) => r.status === "rejected");
    if (error) ctx.err(`starbridge: question not sent: ${(error.reason as Error).message}`);
    if (picked.every((p) => p !== undefined) && !signal.aborted) {
      ctx.out(JSON.stringify({ answers: picked }));
      return 0;
    }
    // Answered or dismissed at the terminal, or a question could not be asked: the ones still
    // open are moot. A settle of one answered meanwhile does nothing.
    const outcome = outer.signal?.aborted ? "elsewhere" : "withdrawn";
    await Promise.all(
      ids.map((id) =>
        id
          ? settle({ ...ctx, signal: undefined }, { id, outcome }).catch((e) =>
              ctx.err(`starbridge: could not settle ${id}: ${(e as Error).message}`),
            )
          : undefined,
      ),
    );
  } catch (e) {
    ctx.err(`starbridge: question not sent: ${(e as Error).message}`);
  } finally {
    watch.stop();
  }
  return 0;
}

/*
 * Cursor (#956). Nothing puts a message into a live Cursor chat except the `stop` hook's
 * `followup_message`, which Cursor submits as the next user message. So the Starbridge Cursor
 * plugin's stop hook holds while the conversation has a question open, up to CURSOR_HOLD_MS, and
 * returns the answer that way. Its sessionStart hook tells the local agent the conversation has
 * the plugin, which is what lets `ask` promise a prompt there.
 */

/** How long the stop hook holds for an answer; the chat shows busy meanwhile. */
export const CURSOR_HOLD_MS = 10 * 60_000;

/** How long one wait for the agent's events or the server's answers holds. */
const CYCLE_SECONDS = 25;

interface CursorHook {
  hook_event_name?: unknown;
  conversation_id?: unknown;
  session_id?: unknown;
  generation_id?: unknown;
  loop_count?: unknown;
  status?: unknown;
  workspace_roots?: unknown;
}

/**
 * Takes the stop of one turn for this process. `cursor-agent` 2026.10.01 runs each stop hook twice
 * at once, with the same input; only one may hold, or an answer could go in twice. False when
 * another process took it.
 */
export function claimStop(ctx: Ctx, hook: CursorHook): boolean {
  const dir = join(ctx.store.dir, "cursor-stops");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // File times are the wall clock's.
  const now = Date.now();
  for (const f of readdirSync(dir))
    try {
      if (now - statSync(join(dir, f)).mtimeMs > 86_400_000) rmSync(join(dir, f), { force: true });
    } catch {}
  const turn = JSON.stringify([hook.conversation_id, hook.generation_id, hook.loop_count]);
  const name = createHash("sha256").update(turn).digest("hex").slice(0, 32);
  try {
    closeSync(openSync(join(dir, name), "wx"));
    return true;
  } catch {
    return false;
  }
}

/** The questions conversation `id` asked that wait for an answer it has not taken. */
export function openQuestions(st: State, id: string): string[] {
  return Object.entries(st.asked)
    .filter(
      ([d, a]) => a.session === id && !a.settled && !a.revoked && !a.held && !st.answers[d]?.seen,
    )
    .map(([d]) => d);
}

/**
 * `starbridge hook session --agent cursor`, the Cursor plugin's sessionStart, stop and sessionEnd
 * hooks, their JSON on stdin. Never fails the hook: on any error it prints nothing.
 */
export async function hookCursorSession(outer: Ctx, stdin: string): Promise<number> {
  // Cursor killed or gone: an answer taken now would reach no chat.
  const watch = untilOrphaned(outer.signal);
  const ctx = { ...outer, signal: watch.signal };
  try {
    const hook = JSON.parse(stdin) as CursorHook;
    const id =
      typeof hook.conversation_id === "string"
        ? hook.conversation_id
        : typeof hook.session_id === "string"
          ? hook.session_id
          : "";
    if (!id) return 0;
    const event = hook.hook_event_name;
    // `cursor-agent -p` never runs stop hooks (2026.10.01), so nothing would take the answer.
    const print = cursorAgentArgs().some((a) => a === "-p" || a === "--print");
    if ((event === "sessionStart" || event === "stop") && !print) await hello(ctx, id, hook);
    if (event === "sessionEnd") await call(ctx, (a) => a.call("POST", path(id, "bye"), {}, 5_000));
    // A turn the owner stopped, or that failed, ends without a hold.
    if (event !== "stop" || hook.status !== "completed") return 0;
    if (!ctx.store.machine() || openQuestions(ctx.store.state(), id).length === 0) return 0;
    if (!claimStop(ctx, hook)) return 0;
    const held = await hold(ctx, id);
    if (!held) return 0;
    // Printed before it is confirmed: at worst a later stop hands the same answer again.
    ctx.out(JSON.stringify({ followup_message: held.message }));
    await held
      .ack()
      .catch((e) => ctx.err(`starbridge: could not confirm the answers: ${(e as Error).message}`));
  } catch (e) {
    ctx.err(`starbridge: ${(e as Error).message}`);
  } finally {
    watch.stop();
  }
  return 0;
}

const path = (id: string, what: string) => `/v1/sessions/${encodeURIComponent(id)}/${what}`;

/** A call to the local agent; without one, nothing. */
async function call(ctx: Ctx, fn: (a: AgentClient) => Promise<unknown>): Promise<void> {
  await withAgent(ctx, fn, async () => undefined).catch(() => undefined);
}

/** Tells the agent this conversation runs the plugin, so `ask` promises a prompt in it. */
async function hello(ctx: Ctx, id: string, hook: CursorHook) {
  const roots = Array.isArray(hook.workspace_roots) ? hook.workspace_roots : [];
  const cwd = typeof roots[0] === "string" ? roots[0] : undefined;
  await call(ctx, (a) => a.call("POST", path(id, "hello"), { ...(cwd ? { cwd } : {}) }, 5_000));
}

/** Answer lines for the chat, and how to confirm them once printed. */
interface Taken {
  lines: string[];
  ack: () => Promise<unknown>;
}

/**
 * One wait of at most `seconds` for conversation `id`'s answers, through the agent or the server.
 * Returns what came, or undefined when nothing did.
 */
async function cycle(ctx: Ctx, id: string, seconds: number): Promise<Taken | undefined> {
  return withAgent(
    ctx,
    async (agent) => {
      const { events } = await agent.call<{ events: SessionEvent[] }>(
        "GET",
        `${path(id, "events")}?wait=${seconds}`,
        undefined,
        (seconds + 15) * 1000,
        ctx.signal,
      );
      const answers = events.filter((e) => e.type === "answer");
      if (answers.length === 0) return undefined;
      return {
        lines: answers.map((e) => e.line),
        ack: () => agent.call("POST", path(id, "ack"), { acks: answers.map((e) => e.ack) }),
      };
    },
    async () => {
      // An answer from a device revoked since never counts, as the agent's events route drops it.
      await dropRevokedNow(ctx);
      let found = sessionLines(ctx.store.state(), id);
      if (found.length === 0) {
        await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds, shared: true });
        found = sessionLines(ctx.store.state(), id);
      }
      if (found.length === 0) return undefined;
      const acks = found.map((l) => l.ack);
      return {
        lines: found.map((l) => l.line),
        ack: async () => ctx.store.updateState((st) => ackLines(st, id, acks)),
      };
    },
  );
}

/**
 * Waits for the answers to conversation `id`'s questions until CURSOR_HOLD_MS, through errors.
 * Returns them as one message, or at the cap what `ask` says when nothing brings an answer back;
 * undefined once no question is open any more, or when Cursor is gone.
 */
async function hold(
  ctx: Ctx,
  id: string,
): Promise<{ message: string; ack: () => Promise<unknown> } | undefined> {
  const deadline = ctx.now().getTime() + CURSOR_HOLD_MS;
  const left = () => deadline - ctx.now().getTime();
  while (left() > 0) {
    if (ctx.signal?.aborted) return undefined;
    if (openQuestions(ctx.store.state(), id).length === 0) return undefined;
    const seconds = Math.max(1, Math.min(CYCLE_SECONDS, Math.ceil(left() / 1000)));
    try {
      const taken = await cycle(ctx, id, seconds);
      if (taken) return { message: taken.lines.join("\n\n"), ack: taken.ack };
    } catch (e) {
      if (ctx.signal?.aborted) return undefined;
      // Pairing or the directory gone wrong: no retry mends it, and `wait` would fail the same.
      if (e instanceof UsageError || e instanceof ProtocolError) throw e;
      ctx.err(`starbridge: ${(e as Error).message}; retrying`);
      await ctx.sleep(Math.min(5_000, Math.max(0, left())));
    }
  }
  const st = ctx.store.state();
  const open = openQuestions(st, id);
  if (open.length === 0) return undefined;
  const message = open
    .map(
      (d) => `No answer yet to ${d} (${st.asked[d]?.question ?? ""}). ${deliveryLine(d, "wait")}`,
    )
    .join("\n\n");
  return { message, ack: async () => {} };
}
