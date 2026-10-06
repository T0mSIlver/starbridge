/**
 * The commands Claude Code's hooks run (#57). `hook permission` runs on `PermissionRequest`: it
 * posts the prompt, waits for a device's answer and prints it as the hook's decision. `hook
 * settle` runs on `PostToolUse`, `PermissionDenied`, `Stop` and `SessionEnd`: the keyboard or the
 * Claude app answered, so the waiting prompt is settled and its hook lets go.
 *
 * Neither ever allows anything by itself: on any error, timeout or lost network they print
 * nothing and exit 0, and Claude Code's own dialog decides. `hook ask-user` and `hook question`
 * do the same for questions asked in the terminal, Claude Code's and opencode's.
 */
import { basename } from "node:path";
import type { Answer, Permission } from "@starbridge/protocol";
import { MAX_HOLD_SECONDS } from "./agent/api";
import { type AgentClient, Interrupted, withAgent } from "./agent/client";
import type { PermissionWait } from "./agent/permissions";
import { type Ctx, parseDuration, session, UsageError } from "./context";
import { type AskInput, ask, poll, settle } from "./decisions";
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

function agentName(text: string | undefined): Permission["agent"] {
  // Pi asks through the Starbridge Pi extension's link in pi-permission-system (#232), opencode
  // through the Starbridge opencode plugin (#300).
  if (text === "claude-code" || text === "pi" || text === "opencode") return text;
  // Not Codex: its hook races its TUI in ways not yet worked out (#57).
  throw new UsageError(`--agent: claude-code, pi or opencode (got ${text ?? "nothing"})`);
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

/** `starbridge hook permission --agent claude-code [--wait 570s]`, hook JSON on stdin. */
export async function hookPermission(
  outer: Ctx,
  stdin: string,
  opts: { agent?: string; wait?: string },
): Promise<number> {
  const watch = untilOrphaned(outer.signal);
  const ctx = { ...outer, signal: watch.signal };
  try {
    if (!permissionsEnabled(ctx)) return 0;
    const agent = agentName(opts.agent);
    const hook = parseHook(stdin);
    const waitMs = opts.wait ? parseDuration(opts.wait) : DEFAULT_WAIT_MS;
    const deadline = ctx.now().getTime() + waitMs;
    const source = permissionSource(hook, ctx.env);
    const output = await withAgent(
      ctx,
      (a) => viaAgent(ctx, a, { hook, agent, source, waitMs }, deadline),
      () => direct(ctx, { hook, agent, source, waitMs }, deadline),
    );
    if (output !== undefined) ctx.out(JSON.stringify(output));
  } catch (e) {
    ctx.err(`starbridge: permission prompt not sent: ${(e as Error).message}`);
  } finally {
    watch.stop();
  }
  return 0;
}

type Ask = Parameters<typeof postPermission>[3] & { hook: PermissionHookInput };

async function viaAgent(
  ctx: Ctx,
  agent: AgentClient,
  ask: Ask,
  deadline: number,
): Promise<unknown> {
  let id: string;
  try {
    ({ id } = await agent.call<{ id: string }>(
      "POST",
      "/v1/permissions",
      ask,
      Math.max(1, deadline - ctx.now().getTime()),
      ctx.signal,
    ));
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
        { wait },
        wait * 1000 + SLACK_MS,
        ctx.signal,
      );
      if (r.output !== undefined) return r.output;
      if (r.settled) return undefined;
    }
    await agent.call("POST", `${path}/settle`, { outcome: "timeout" }, 5_000);
  } catch (e) {
    // Claude Code sends SIGTERM when the keyboard answers Esc or No.
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
    // Claude Code sends SIGTERM when the keyboard answers Esc or No; it drops a later answer.
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

/** `starbridge hook settle --agent claude-code`, hook JSON on stdin. */
export async function hookSettle(
  ctx: Ctx,
  stdin: string,
  opts: { agent?: string },
): Promise<number> {
  try {
    agentName(opts.agent);
    const hook = parseHook(stdin);
    const sessionId = typeof hook.session_id === "string" ? hook.session_id : "";
    // Runs after a tool call while a prompt is open: nothing waiting for this session means no
    // network and no agent call. With none open at all, the marker is left over, such as from a
    // state a new pairing replaced: dropped under the lock.
    const st = ctx.store.state();
    if (ctx.store.promptsMarked() && !Object.values(st.permissions ?? {}).some((p) => !p.settled))
      ctx.store.updateState(() => {});
    if (!sessionId || waitingFor(st, sessionId).length === 0) return 0;
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

/** The answer an agent reads to each question of an `AskUserQuestion` turned away. */
export const ASK_USER_REASON =
  "Not answered here: the user is away from this terminal, so ask through Starbridge instead. Run `starbridge ask` with the question, the context they need to answer it cold, the options and what each one changes, your recommendation first, as the `starbridge` skill says. Then keep working on what does not depend on the answer.";

/** How long the server may take to answer before the hook lets `AskUserQuestion` through. */
const REACH_MS = 3_000;

/**
 * `starbridge hook ask-user`, on `PreToolUse` for `AskUserQuestion`: answers each question with
 * `ASK_USER_REASON`, so the agent asks through `starbridge ask`, which reaches the owner away
 * from the terminal. Claude Code shows that as an answered question; a deny would show as a red
 * hook error. Input it cannot read is denied instead. When the machine is not paired or its
 * server does not answer, it prints nothing and Claude Code asks as usual, so an agent always
 * has a way to ask.
 */
export async function hookAskUser(ctx: Ctx, stdin: string): Promise<number> {
  try {
    const machine = ctx.store.machine();
    if (!machine) return 0;
    const res = await fetch(`${machine.server.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(REACH_MS),
    });
    if (!res.ok) return 0;
  } catch {
    return 0;
  }
  let input: { questions: { question: string }[] } | undefined;
  try {
    const parsed = JSON.parse(stdin) as { tool_input?: { questions?: unknown } };
    const questions = parsed.tool_input?.questions;
    if (
      Array.isArray(questions) &&
      questions.length > 0 &&
      questions.every((q) => typeof (q as { question?: unknown })?.question === "string")
    )
      input = parsed.tool_input as typeof input;
  } catch {}
  const hookSpecificOutput = input
    ? {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          ...input,
          answers: Object.fromEntries(input.questions.map((q) => [q.question, ASK_USER_REASON])),
        },
      }
    : {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ASK_USER_REASON,
      };
  ctx.out(JSON.stringify({ hookSpecificOutput }));
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
 * it goes to the server itself, since an agent older than `held` would record the session.
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
          project: basename(hook.cwd || process.cwd()),
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
