import type { Answer } from "@starbridge/protocol";
import { type HooklessCopy, hooklessCopies } from "../claude";
import type { State } from "../config";
import { type Ctx, UsageError } from "../context";
import type { AskInput } from "./source";

/**
 * How an answer comes back into the session that asked: as a prompt, which Claude Code's mod,
 * the Pi extension and the opencode plugin submit and the agent queues into a Codex session it
 * can reach, or only through `wait`.
 */
export type Delivery = "prompt" | "wait";

/**
 * A prompt only when something will submit it (#537): for Claude Code, a mod seen polling for
 * this session (`modSeen`), which an installed plugin alone does not mean; for Pi and opencode,
 * their extension, which says so itself; for Codex, its reachable app-server; for Antigravity,
 * its reachable language server (#961). With no agent running, Codex and Antigravity get
 * nothing back.
 */
export function delivery(
  input: Pick<AskInput, "agent" | "extensionAnswers" | "headless" | "antigravity" | "subagent">,
  reachable: boolean,
  modSeen: boolean,
): Delivery {
  if (input.agent === "antigravity") return input.antigravity && reachable ? "prompt" : "wait";
  // The mod runs its loop only in a session that stays open (#863), so a seen mod outweighs
  // `headless`, which T3 Code's SDK sessions carry as `claude -p` does (#2100). Only the mod
  // names a subagent, so one runs in this session (#1702).
  if (input.agent === "claude-code" || input.agent === "cursor")
    return modSeen || (!input.headless && !!input.subagent) ? "prompt" : "wait";
  if (input.agent === "pi" || input.agent === "opencode")
    return input.extensionAnswers ? "prompt" : "wait";
  return input.agent === "codex" && reachable ? "prompt" : "wait";
}

/**
 * How long after its last call the agent still counts a Claude Code session's mod as there: one
 * events call held 25 s, and the next one. A Cursor conversation counts until its sessionEnd hook
 * says goodbye, since its hooks call only at session start and at each stop (#956).
 */
export const MOD_SEEN_MS = 45_000;

/** What `ask` prints after the id, on stderr, so the asking agent knows what to do next. */
export function deliveryLine(id: string, d: Delivery): string {
  return d === "prompt"
    ? "The answer will come back into this session as a new prompt."
    : `Nothing brings the answer into this session: when only the answer is left, run \`starbridge wait ${id} --timeout 5m\` (again on exit 2).`;
}

/**
 * Why no mod runs in this Claude Code session when Claude desktop replaced Starbridge's plugins
 * with copies that have no hooks (#1428).
 */
export function hooklessLine(copies: HooklessCopy[]): string {
  const what = copies.map((c) => `${c.name} (${c.dir})`).join(" and ");
  return `Claude desktop runs this session with its own ${copies.length > 1 ? "copies" : "copy"} of ${what}, synced without hooks from the computer it runs on, in place of this machine's.`;
}

/**
 * What `ask` adds to the `wait` line in a Claude Code session that Claude desktop runs with
 * hookless copies of Starbridge's plugins (#1428); none elsewhere.
 */
export function askLines(
  input: Pick<AskInput, "agent" | "headless" | "session">,
  d: Delivery,
  env: Ctx["env"],
  argsOf?: (pid: number) => string[],
): string[] {
  if (d !== "wait" || input.agent !== "claude-code" || input.headless || !input.session) return [];
  const copies = hooklessCopies(env, input.session, argsOf);
  return copies.length > 0 ? [hooklessLine(copies)] : [];
}

/**
 * What `ask --answer-in` adds, so only an agent that built such a page reads how its answer comes
 * (#1063).
 */
export function answerInLine(id: string): string {
  return `When the page's message brings the pick, run \`starbridge settle ${id}\`, then act. If the owner taps Done on the card instead, the answer says \`${DONE_LINE}\`: read the pick there and act, with no settle.`;
}

/** The line `wait` prints and the mod submits; the decision skill tells agents to expect it. */
export function answerLine(a: Answer, question: string | undefined): string {
  return answerPrefix(a.decisionId, question) + (a.choice ?? a.text ?? DONE_LINE);
}

/** `answerLine` up to the answer itself. */
export function answerPrefix(id: string, question: string | undefined): string {
  return `Answer to ${id}${question ? ` (${question})` : ""}: `;
}

/** What a Done says to the agent: the answer is on the page the question named (#539). */
export const DONE_LINE = "answered on its page; read the answer there";

export function printAnswer(ctx: Ctx, a: Answer, question: string | undefined, json?: boolean) {
  ctx.out(json ? JSON.stringify(a) : answerLine(a, question));
}

/** Why no answer to decision `id` will come, for `wait`: settled, answered elsewhere, or revoked. */
export function closedError(ctx: Ctx, id: string | undefined): UsageError | undefined {
  const st = ctx.store.state();
  const a = id === undefined ? undefined : st.asked[id];
  if (!id || !a) return undefined;
  if (a.revoked)
    return new UsageError(
      `${named(id, a.question)} was answered from a device removed since, so that answer does not count and no other will come: ask again if you still need it`,
    );
  if (a.settled)
    return new UsageError(
      `${named(id, a.question)} was ${closedHow(st, id, ctx.now())}: no answer will come`,
    );
  if (a.answerIn && !a.done)
    return new UsageError(
      `${named(id, a.question)} takes its answer on its own page: no answer will come here`,
    );
}

/** How a line names a decision: its id, and its question beside it, so a reader sees which card (#1697). */
export function named(id: string, question: string | undefined): string {
  return `${id}${question ? ` (${question})` : ""}`;
}

/** "13:02", "yesterday 13:02", "Mon 12 Oct 13:02": a time that has passed, in this machine's zone. */
export function pastTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => d.toDateString();
  if (day(at) === day(now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(at) === day(yesterday)) return `yesterday ${time}`;
  return `${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/**
 * How decision `id` closed, for what is said of a card that takes no answer: `answered at 13:02:
 * Done`, `withdrawn at 13:02: <reason>`, `answered elsewhere at 13:02`. Undefined while it is open.
 */
export function closedHow(st: State, id: string, now: Date): string | undefined {
  const at = (iso: string | undefined) => {
    const d = iso ? new Date(iso) : undefined;
    return d && !Number.isNaN(d.getTime()) ? ` at ${pastTime(d, now)}` : "";
  };
  const answer = st.answers[id]?.answer;
  if (answer)
    return `answered${at(answer.answeredAt)}: ${answer.choice ?? answer.text ?? DONE_LINE}`;
  const a = st.asked[id];
  if (!a?.settled) return undefined;
  if (a.revoked) return "answered from a device removed since, so that answer does not count";
  if (a.outcome === "withdrawn")
    return `withdrawn${at(a.settledAt)}${a.reason ? `: ${a.reason}` : ""}`;
  if (a.outcome === "elsewhere") return `answered elsewhere${at(a.settledAt)}`;
  return "settled";
}

/** What `waiting`, `working` and `settle` say of a card that is closed already. */
export function staleLine(st: State, id: string, now: Date): string {
  return `${named(id, st.asked[id]?.question)} was already ${closedHow(st, id, now) ?? "closed"}`;
}
