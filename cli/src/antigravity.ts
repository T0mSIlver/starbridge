/**
 * Antigravity sessions: the app, the IDE and the `agy` CLI. Each gives the commands its agent runs
 * the conversation's id in `ANTIGRAVITY_CONVERSATION_ID`, and keeps the title it generates for a
 * conversation in `~/.gemini/<product>/annotations/<id>.pbtxt`, a protobuf text file such as
 * `title:"Fix the build"`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ownCommand } from "../../mod/hooks/own";
import { type SessionEvent, socketPath } from "./agent/api";
import { AgentClient, withAgent } from "./agent/client";
import type { State } from "./config";
import { type Ctx, session, UsageError } from "./context";
import { ackLines, deliverable, poll, sessionLines } from "./decisions";
import { permissionsEnabled } from "./permissions";

/** The conversation's id, in every command the agent runs. */
export const ANTIGRAVITY_CONVERSATION = "ANTIGRAVITY_CONVERSATION_ID";

/**
 * Where the language server of the Antigravity process running a conversation listens, with the
 * token it takes (#961). Commands get both, hooks and MCP servers neither.
 */
export interface AgyRoute {
  address: string;
  token: string;
}

/**
 * The conversation's route from its command's environment: only on loopback, since the token
 * goes with every call, and not in `agy -p`, whose server is gone once its run ends.
 */
export function agyRoute(env: Ctx["env"]): AgyRoute | undefined {
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  const token = env.ANTIGRAVITY_CSRF_TOKEN;
  if (!address || !token || !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(address))
    return undefined;
  return agyHeadless() ? undefined : { address, token };
}

/** The process ids and arguments of this process's parents, nearest first, up to `max`. */
function parents(max: number): string[][] {
  const out: string[][] = [];
  let pid = process.ppid;
  for (let i = 0; i < max && pid > 1; i++) {
    let args: string[];
    let ppid: number;
    if (process.platform === "linux") {
      try {
        args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        // The command name in `stat` may hold spaces and parentheses: read after the last one.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } catch {
        break;
      }
    } else if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" });
      const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout?.trim() ?? "");
      if (!m) break;
      ppid = Number(m[1]);
      args = (m[2] as string).split(" ");
    } else break;
    out.push(args);
    pid = ppid;
  }
  return out;
}

/** Whether an `agy -p` (`--print`, `--prompt`) runs this command. */
export function agyHeadless(): boolean {
  const agy = parents(8).find((a) => /^agy(\.exe)?$/.test(basename(a[0] ?? "")));
  return !!agy?.slice(1).some((a) => a === "-p" || a === "--print" || a === "--prompt");
}

const LS = "exa.language_server_pb.LanguageServerService";

export async function lsCall<T>(route: AgyRoute, method: string, body: unknown): Promise<T> {
  const r = await fetch(`http://${route.address}/${LS}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codeium-csrf-token": route.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

/**
 * Hands the agent the route of the Antigravity process this command runs in, so it watches that
 * process's prompts (#962). Any starbridge command does it; a missing or slow agent costs it at
 * most half a second.
 */
export async function registerAgyRoute(ctx: Ctx): Promise<boolean> {
  if (!ctx.env.ANTIGRAVITY_LS_ADDRESS) return false;
  const route = agyRoute(ctx.env);
  const agent = route && AgentClient.for(ctx);
  if (!agent) return false;
  try {
    await agent.call("POST", "/v1/antigravity/routes", route, 500);
  } catch {
    return false;
  }
  const id = ctx.env[ANTIGRAVITY_CONVERSATION];
  if (id) markConversation(ctx, id);
  return true;
}

/**
 * Records that conversation `id` needs no `starbridge hello`: it registered, or prompts are off.
 * The plugin's shell checks read it, so the CLI no longer starts for its calls.
 */
function markConversation(ctx: Ctx, id: string) {
  if (!/^[\w-]+$/.test(id)) return;
  const dir = join(ctx.store.dir, "antigravity");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, id), "");
}

/**
 * Whether conversation `id` still has to run `starbridge hello` for its prompts to go out: prompts
 * on, a local agent to take the key, and no command of it registered yet.
 */
function needsHello(ctx: Ctx, id: unknown): boolean {
  if (typeof id !== "string" || !/^[\w-]+$/.test(id)) return false;
  if (existsSync(join(ctx.store.dir, "antigravity", id))) return false;
  // `agy -p` registers no route, so a hello there would only fail.
  if (permissionsEnabled(ctx) && existsSync(socketPath(ctx.env, ctx.store.dir)) && !agyHeadless())
    return true;
  markConversation(ctx, id);
  return false;
}

/** What the agent is told, at the start of a turn, until the conversation registered. */
export const NUDGE =
  "Starbridge sends this session's permission prompts and questions to the owner's phone once it has run a starbridge command. Before anything else, run `starbridge hello` once.";

/**
 * `starbridge hook pre-invocation --agent antigravity`, on the plugin's `PreInvocation` at the
 * start of a turn whose conversation has not registered (#962): with permission prompts on,
 * tells the agent to run `starbridge hello`; else nothing.
 */
export function hookPreInvocation(ctx: Ctx, text: string, opts: { agent?: string }): number {
  if (opts.agent !== "antigravity")
    throw new UsageError(`--agent: antigravity (got ${opts.agent ?? "nothing"})`);
  let id: unknown;
  try {
    id = (JSON.parse(text) as { conversationId?: unknown }).conversationId;
  } catch {}
  ctx.out(
    JSON.stringify(needsHello(ctx, id) ? { injectSteps: [{ ephemeralMessage: NUDGE }] } : {}),
  );
  return 0;
}

/** `starbridge hello`: hands Starbridge this Antigravity session's route, and says whether it took. */
export async function hello(ctx: Ctx): Promise<number> {
  if (!ctx.env.ANTIGRAVITY_LS_ADDRESS) {
    ctx.out("Nothing to do: this is not an Antigravity session.");
    return 0;
  }
  if (!agyRoute(ctx.env)) {
    ctx.out("Nothing to do: agy -p keeps its prompts at the keyboard.");
    return 0;
  }
  if (await registerAgyRoute(ctx)) {
    ctx.out("Starbridge now sends this session's prompts to the owner's devices.");
    return 0;
  }
  ctx.err("starbridge: the Starbridge agent is not running: prompts stay at the keyboard.");
  return 1;
}

/** Whether the route's language server answers, so its process still runs. */
export async function agyReachable(route: AgyRoute): Promise<boolean> {
  try {
    const r = await fetch(`http://${route.address}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Sends `text` into conversation `id` as the owner's next message, run once the conversation
 * is idle, as `codex queue` does. The call must name the model, or the turn fails; the one the
 * conversation last ran keeps it as it was. Returns why it failed, or undefined.
 */
export async function agySend(
  route: AgyRoute,
  id: string,
  text: string,
): Promise<string | undefined> {
  try {
    const meta = await lsCall<{ generatorMetadata?: { chatModel?: { model?: string } }[] }>(
      route,
      "GetCascadeTrajectoryGeneratorMetadata",
      { cascadeId: id },
    );
    const model = meta.generatorMetadata?.findLast((m) => m.chatModel?.model)?.chatModel?.model;
    if (!model) return "the conversation has run no model yet";
    await lsCall(route, "SendUserCascadeMessage", {
      cascadeId: id,
      items: [{ text }],
      deliveryStrategy: "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE",
      cascadeConfig: { plannerConfig: { planModel: model } },
    });
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Each product's folder under `~/.gemini`: the CLI, the app, the IDE. */
const PRODUCTS = ["antigravity-cli", "antigravity", "antigravity-ide"];

/** The conversation's title, from whichever product's annotations hold it. */
export function antigravityTitle(env: Ctx["env"], conversation: string): string | undefined {
  const home = env.HOME || env.USERPROFILE;
  // The id names a file: never let it leave the annotations folder.
  if (!home || !/^[\w-]+$/.test(conversation)) return undefined;
  for (const product of PRODUCTS) {
    let text: string;
    try {
      text = readFileSync(
        join(home, ".gemini", product, "annotations", `${conversation}.pbtxt`),
        "utf8",
      );
    } catch {
      continue;
    }
    const title = pbtxtString(text, "title")?.trim();
    if (title) return title.slice(0, 200);
  }
  return undefined;
}

/**
 * Field `name`'s string in protobuf text format. Go's encoder puts any spacing after the colon,
 * escapes quotes and backslashes, and writes control bytes and invalid UTF-8 in hex or `\u`.
 */
export function pbtxtString(text: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!m) return undefined;
  const bytes: number[] = [];
  const raw = Buffer.from(m[1] as string, "utf8");
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as number;
    if (c !== 0x5c) {
      bytes.push(c);
      continue;
    }
    const e = String.fromCharCode(raw[++i] as number);
    if (e in simple) bytes.push(simple[e] as number);
    else if (e === "x") {
      const hex = raw.subarray(i + 1, i + 3).toString("latin1");
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (e === "u" || e === "U") {
      const n = e === "u" ? 4 : 8;
      const cp = Number.parseInt(raw.subarray(i + 1, i + 1 + n).toString("latin1"), 16);
      bytes.push(...Buffer.from(String.fromCodePoint(cp), "utf8"));
      i += n;
    } else if (/[0-7]/.test(e)) {
      const oct = raw.subarray(i, i + 3).toString("latin1");
      bytes.push(Number.parseInt(oct, 8));
      i += 2;
    } else bytes.push(e.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** What Antigravity's `PreToolUse` hook gets on stdin, the parts Starbridge reads. */
export interface PreToolInput {
  conversationId?: string;
  workspacePaths?: string[];
  toolCall?: { name?: string; args?: Record<string, unknown> };
}

/** A starbridge command an AGY_ALLOW entry lets through, wherever it sits on the line. */
const ALLOWED = /(^|[^\w-])starbridge\s+(ask|waiting|working|wait|settle|hello)(?![\w-])/;

/**
 * `starbridge hook pre-tool --agent antigravity`, on the plugin's `PreToolUse` for
 * `run_command` (#959). The allow entries setup adds to `agy`'s settings skip the prompt; this
 * hook narrows them. A line that is one of those commands alone runs outside `--sandbox`, which
 * has no network and hides the home folder. A line they would pass but that runs more, such as
 * `LD_PRELOAD=… starbridge ask`, gets the prompt back (`force_ask`). `agy` ignores a hook's
 * `allow` otherwise. Prints nothing for any other call.
 */
export function hookPreTool(ctx: Ctx, text: string, opts: { agent?: string }): number {
  if (opts.agent !== "antigravity")
    throw new UsageError(`--agent: antigravity (got ${opts.agent ?? "nothing"})`);
  let input: PreToolInput;
  try {
    input = JSON.parse(text) as PreToolInput;
  } catch {
    return 0;
  }
  const line = input?.toolCall?.args?.CommandLine;
  if (input?.toolCall?.name !== "run_command" || typeof line !== "string") return 0;
  // A model may pass over the PreInvocation nudge; a denied command it has to retry it cannot.
  if (!ownCommand(line) && needsHello(ctx, input.conversationId)) {
    // Once only: a hello that fails leaves the prompts at the keyboard, not the session stuck.
    markConversation(ctx, input.conversationId as string);
    ctx.out(JSON.stringify({ decision: "deny", reason: `${NUDGE} Then run this command again.` }));
  } else if (ownCommand(line))
    ctx.out(JSON.stringify({ decision: "allow", overwrite: { BypassSandbox: true } }));
  else if (ALLOWED.test(line))
    ctx.out(
      JSON.stringify({
        decision: "force_ask",
        reason: "Starbridge lets its commands skip the prompt only alone on their line.",
      }),
    );
  return 0;
}

/** How long the Stop hook holds the end of a turn for an answer the session waits on. */
export const HOLD_MS = 10 * 60_000;
/** Each cycle of that hold, under the 30 s a held call to the agent may take. */
const CYCLE_SECONDS = 25;

/**
 * Whether conversation `id` waits on an answer nothing else brings: a decision it asked from
 * `agy -p`, or with no route to its language server, is marked waiting, open, and not snoozed
 * past now.
 */
export function waitsOn(st: State, id: string, now: Date): boolean {
  return Object.entries(st.asked).some(
    ([d, a]) =>
      a.session === id &&
      !a.antigravity &&
      a.waiting?.state === "waiting" &&
      !st.answers[d] &&
      deliverable(st, d) &&
      !(a.snooze && Date.parse(a.snooze.until) > now.getTime()),
  );
}

/** The lines of answers to conversation `id`, held up to `seconds` for one; each taken once. */
async function takeLines(ctx: Ctx, id: string, seconds: number): Promise<string[]> {
  const path = `/v1/sessions/${encodeURIComponent(id)}`;
  return withAgent(
    ctx,
    async (agent) => {
      const { events } = await agent.call<{ events: SessionEvent[] }>(
        "GET",
        `${path}/events?wait=${seconds}`,
        undefined,
        seconds * 1000 + 15_000,
        ctx.signal,
      );
      if (events.length > 0)
        await agent.call("POST", `${path}/ack`, { acks: events.map((e) => e.ack) });
      return events.map((e) => e.line);
    },
    async () => {
      let lines = sessionLines(ctx.store.state(), id);
      if (lines.length === 0 && seconds > 0) {
        await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds, shared: true });
        lines = sessionLines(ctx.store.state(), id);
      }
      ctx.store.updateState((st) =>
        ackLines(
          st,
          id,
          lines.map((l) => l.ack),
        ),
      );
      return lines.map((l) => l.line);
    },
  );
}

/**
 * `starbridge hook stop --agent antigravity`, on the plugin's `Stop` hook (#961): the answers
 * that came in for the conversation go back into it as the hook's `continue` reason, which
 * Antigravity adds as a system message and runs another turn on. While a question the
 * conversation asked is marked waiting, the hook holds the end of the turn for its answer, at
 * most HOLD_MS. Prints nothing when there is nothing to hand over, so the turn ends.
 */
export async function hookStop(ctx: Ctx, text: string, opts: { agent?: string }): Promise<number> {
  if (opts.agent !== "antigravity")
    throw new UsageError(`--agent: antigravity (got ${opts.agent ?? "nothing"})`);
  let id: unknown;
  try {
    id = (JSON.parse(text) as { conversationId?: unknown }).conversationId;
  } catch {
    return 0;
  }
  if (typeof id !== "string" || !id || !ctx.store.machine()) return 0;
  const until = ctx.now().getTime() + HOLD_MS;
  let seconds = 0;
  try {
    for (;;) {
      const lines = await takeLines(ctx, id, seconds);
      if (lines.length > 0) {
        ctx.out(JSON.stringify({ decision: "continue", reason: lines.join("\n") }));
        return 0;
      }
      const left = until - ctx.now().getTime();
      if (left <= 0 || !waitsOn(ctx.store.state(), id, ctx.now())) return 0;
      seconds = Math.max(1, Math.min(CYCLE_SECONDS, Math.ceil(left / 1000)));
    }
  } catch (e) {
    // The turn ends as it would without Starbridge; `wait` still reads the answer later.
    ctx.err(`starbridge: ${(e as Error).message}`);
    return 0;
  }
}
