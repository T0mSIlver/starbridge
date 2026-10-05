/**
 * The commands Claude Code's hooks run (#57). `hook permission` runs on `PermissionRequest`: it
 * posts the prompt, waits for a device's answer and prints it as the hook's decision. `hook
 * settle` runs on `PostToolUse`, `PermissionDenied`, `Stop` and `SessionEnd`: the keyboard or the
 * Claude app answered, so the waiting prompt is settled and its hook lets go.
 *
 * Neither ever allows anything by itself: on any error, timeout or lost network they print
 * nothing and exit 0, and Claude Code's own dialog decides.
 */
import { hashInput, type Permission } from "@starbridge/protocol";
import { MAX_HOLD_SECONDS } from "./agent/api";
import { type AgentClient, Interrupted, withAgent } from "./agent/client";
import type { PermissionWait } from "./agent/permissions";
import { type Ctx, parseDuration, session, UsageError } from "./context";
import { poll } from "./decisions";
import {
  DEFAULT_WAIT_MS,
  hookDecision,
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
  // Pi asks through the Starbridge Pi extension's link in pi-permission-system (#232).
  if (text === "claude-code" || text === "pi") return text;
  // Codex's hook races its TUI in ways not probed yet (#57, P3).
  throw new UsageError(`--agent: claude-code or pi (got ${text ?? "nothing"})`);
}

/** `starbridge hook permission --agent claude-code [--wait 570s]`, hook JSON on stdin. */
export async function hookPermission(
  ctx: Ctx,
  stdin: string,
  opts: { agent?: string; wait?: string },
): Promise<number> {
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
    const session = encodeURIComponent(ask.source.session);
    const inputHash = hashInput(JSON.stringify(ask.hook.tool_input ?? {}));
    await agent.call("POST", `/v1/sessions/${session}/permissions/settle`, { inputHash }, 5_000);
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
    if (p.answer) {
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
    // A tool that ran or was denied names its call; the end of a turn or session settles all.
    const inputHash =
      hook.tool_input !== undefined ? hashInput(JSON.stringify(hook.tool_input)) : undefined;
    // Runs after every tool call: nothing waiting means no network and no agent call.
    if (!sessionId || waitingFor(ctx.store.state(), sessionId, inputHash).length === 0) return 0;
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
