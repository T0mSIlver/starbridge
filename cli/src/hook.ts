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
  settle,
  waitingFor,
} from "./permissions";

/** Slack past a held request's `wait` before the hook gives up on the agent. */
const SLACK_MS = 15_000;
/** How long the hook's own path holds each answer poll, so it sees a settle soon. */
const DIRECT_POLL_SECONDS = 5;

function parseHook(text: string): PermissionHookInput & Record<string, unknown> {
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object") throw new UsageError("the hook input is not a JSON object");
  return v as PermissionHookInput & Record<string, unknown>;
}

function agentName(text: string | undefined): Permission["agent"] {
  if (text === "claude-code") return text;
  // Codex's hook races its TUI in ways not probed yet (#57, P3).
  throw new UsageError(`--agent: only claude-code is supported (got ${text ?? "nothing"})`);
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
  const { id } = await agent.call<{ id: string }>("POST", "/v1/permissions", ask);
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
    await agent.call("POST", `${path}/settle`, { outcome: "timeout" });
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
  const id = await postPermission(ctx, s, ask.hook, ask);
  let cursor = ctx.store.state().permissions?.[id]?.cursor;
  let directory: Awaited<ReturnType<typeof poll>>["directory"] | undefined;
  const quiet = { ...ctx, signal: undefined };
  while (true) {
    const p = ctx.store.state().permissions?.[id];
    if (!p || (p.settled && !p.answer)) return undefined;
    if (p.answer && !p.settled) {
      const how = markSettled(ctx, id, "device");
      if (!how) return undefined;
      await postSettled(quiet, s, id, how).catch((e) =>
        ctx.err(`starbridge: could not report the prompt settled: ${(e as Error).message}`),
      );
      return hookDecision(p);
    }
    if (p.settled) return undefined;
    if (ctx.signal?.aborted) {
      await settle(quiet, s, id, "keyboard");
      return undefined;
    }
    const left = deadline - ctx.now().getTime();
    if (left <= 0) {
      await settle(quiet, s, id, "timeout");
      return undefined;
    }
    try {
      const seconds = Math.max(1, Math.min(DIRECT_POLL_SECONDS, Math.ceil(left / 1000)));
      ({ cursor, directory } = await poll(ctx, s, {
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
        for (const id of waitingFor(ctx.store.state(), sessionId, inputHash))
          await settle(ctx, s, id, "keyboard");
      },
    );
  } catch (e) {
    ctx.err(`starbridge: could not settle the permission prompt: ${(e as Error).message}`);
  }
  return 0;
}

/** `starbridge permissions enable|disable|status`. */
export function permissionsCommand(ctx: Ctx, sub: string | undefined): number {
  if (sub === "enable" || sub === "disable") {
    const config = ctx.store.agentConfig();
    ctx.store.saveAgentConfig({ ...config, permissions: { enabled: sub === "enable" } });
  } else if (sub !== "status" && sub !== undefined) {
    throw new UsageError("usage: starbridge permissions enable|disable|status");
  }
  ctx.out(
    permissionsEnabled(ctx)
      ? "Permission prompts go to Starbridge."
      : "Permission prompts stay at the keyboard.",
  );
  return 0;
}
