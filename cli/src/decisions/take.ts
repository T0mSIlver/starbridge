import { type Answer, ProtocolError } from "@starbridge/protocol";
import type { State } from "../config";
import { type Ctx, session, UsageError } from "../context";
import { answerLine } from "./lines";
import { poll } from "./poll";
import { dropRevokedNow } from "./trust";

/**
 * Whether decision `id`'s answer may reach its session: not settled, taking answers (a Done for
 * one answered on its own page), and the machine not behind on the directory.
 */
export function deliverable(st: State, id: string): boolean {
  const asked = st.asked[id];
  return !!asked && !asked.settled && (!asked.answerIn || !!asked.done) && !st.behind;
}

/**
 * The answer to decision `id`, or without `id` the first answer no `wait` printed yet to a
 * decision session `session` asked (any session's when undefined), marked printed. Undefined
 * when there is none yet.
 */
export function takeAnswer(
  store: Ctx["store"],
  id: string | undefined,
  session?: string,
): { answer: Answer; question?: string } | undefined {
  const mine = (st: State, d: string) =>
    !st.asked[d]?.held && (session === undefined || (st.asked[d]?.session ?? "") === session);
  const found = (st: State) =>
    id
      ? deliverable(st, id)
        ? st.answers[id]
        : undefined
      : Object.values(st.answers).find(
          (a) =>
            !a.seen &&
            !steering(a) &&
            deliverable(st, a.answer.decisionId) &&
            mine(st, a.answer.decisionId),
        );
  if (!found(store.state())) return undefined;
  let taken: { answer: Answer; question?: string } | undefined;
  store.updateState((st) => {
    const a = found(st);
    if (!a) return;
    a.seen = true;
    const question = st.asked[a.answer.decisionId]?.question;
    taken = { answer: a.answer, ...(question !== undefined ? { question } : {}) };
  });
  return taken;
}

/** Past this, a steer's claim is from an agent that died mid-steer (#1486); a steer takes 5 s at most. */
const STEER_CLAIM_MS = 30_000;

/** The local agent is steering this answer into a Codex turn (#1486): nothing else hands it over. */
export function steering(a: { steering?: number }, now = Date.now()): boolean {
  return a.steering !== undefined && now - a.steering < STEER_CLAIM_MS;
}

/**
 * `waiting` on a decision whose answer came but has not reached the agent: the agent needs it
 * now, so it gets it at once, marked printed, rather than after its turn (#1484).
 */
export function takeUnseen(
  store: Ctx["store"],
  id: string,
): { answer: Answer; question?: string } | undefined {
  let taken: { answer: Answer; question?: string } | undefined;
  // Checked and marked under one lock, so two `waiting`s, or one and the mod's confirm, never
  // both hand it over.
  store.updateState((st) => {
    const a = st.answers[id];
    if (!a || a.seen || steering(a) || !deliverable(st, id)) return;
    a.seen = true;
    const question = st.asked[id]?.question;
    taken = { answer: a.answer, ...(question !== undefined ? { question } : {}) };
  });
  return taken;
}

/** Keeps a `--wait` cycle under the 30 s the mod's host allows a call to run. */
export const MAX_CYCLE_SECONDS = 25;

/** One line for a session: the answer to a decision it asked. */
export interface SessionLine {
  type: "answer";
  decisionId: string;
  /** What confirms it: the decision id. */
  ack: string;
  line: string;
  /** The decision's question, beside its id (#1697). */
  question: string;
  /**
   * The decision is marked waiting: the agent needs the answer now, so the mod hands it over at
   * the agent's next tool call rather than after its turn (#1484).
   */
  waiting: boolean;
  /** The Claude Code subagent that asked, which the mod sends the answer to (#1702). */
  subagent?: string;
}

/** The answers to decisions session `session` asked that no `wait` printed nor the mod confirmed. */
export function sessionLines(st: State, session: string): SessionLine[] {
  const lines: SessionLine[] = [];
  // Accepted before the machine knew it was behind: held back with the rest.
  if (st.behind) return lines;
  for (const [id, a] of Object.entries(st.answers)) {
    const asked = st.asked[id];
    if (!asked || a.seen || asked.session !== session || !deliverable(st, id)) continue;
    lines.push({
      type: "answer",
      decisionId: id,
      ack: id,
      line: answerLine(a.answer, asked.question),
      question: asked.question,
      waiting: asked.waiting?.state === "waiting",
      ...(asked.subagent ? { subagent: asked.subagent } : {}),
    });
  }
  return lines;
}

/**
 * Confirms lines session `session` submitted; tokens for other sessions' decisions do nothing.
 * Returns the tokens it confirmed now: not one a `wait` or `waiting` printed first (#1484).
 */
export function ackLines(st: State, session: string, tokens: string[]): string[] {
  const acked: string[] = [];
  for (const token of tokens) {
    const a = st.answers[token];
    if (a && !a.seen && st.asked[token]?.session === session) {
      a.seen = true;
      acked.push(token);
    }
  }
  return acked;
}

/** What `answers` prints for each line, as the mod reads it. */
const printLine = (ctx: Ctx, l: SessionLine) =>
  ctx.out(
    JSON.stringify({
      decisionId: l.decisionId,
      ack: l.ack,
      line: l.line,
      question: l.question,
      waiting: l.waiting,
      ...(l.subagent ? { subagent: l.subagent } : {}),
    }),
  );

/**
 * For the Claude Code mod: hands over the answers to decisions that session `session` asked and
 * that neither a `wait` printed nor the mod confirmed, one JSON line `{decisionId, ack, line,
 * waiting}` each. The mod confirms each line it submitted with `--ack <ack>`; until then
 * the next call hands it over again, so a line the mod held back (its session ended meanwhile) is
 * not lost. With `wait`, and nothing to hand over, first long-polls once for at most that many
 * seconds from the shared cursor. One cycle per call: an error exits 1, and the mod decides when
 * to retry. This is the path with no agent running; the agent serves the same lines.
 */
export async function answers(
  ctx: Ctx,
  opts: { session?: string; wait?: string; ack?: string[] },
): Promise<number> {
  const target = opts.session;
  if (!target) throw new UsageError("answers needs --session");
  if (opts.ack) {
    if (opts.wait !== undefined) throw new UsageError("--ack takes no --wait");
    const tokens = opts.ack;
    let acked: string[] = [];
    ctx.store.updateState((st) => {
      acked = ackLines(st, target, tokens);
    });
    ctx.out(JSON.stringify({ acked }));
    return 0;
  }
  const seconds = opts.wait === undefined ? undefined : waitSeconds(opts.wait);
  await dropRevokedNow(ctx);
  const first = sessionLines(ctx.store.state(), target);
  for (const l of first) printLine(ctx, l);
  if (first.length > 0 || seconds === undefined) return 0;
  try {
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds, shared: true });
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProtocolError) throw e;
    ctx.err(`starbridge: ${(e as Error).message}`);
    return 1;
  }
  for (const l of sessionLines(ctx.store.state(), target)) printLine(ctx, l);
  return 0;
}

/** `--wait` for `answers`: whole seconds up to MAX_CYCLE_SECONDS. */
export function waitSeconds(text: string): number {
  const seconds = Number(text);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_CYCLE_SECONDS)
    throw new UsageError(`--wait takes whole seconds from 0 to ${MAX_CYCLE_SECONDS}`);
  return seconds;
}
