import { randomBytes } from "node:crypto";
import { type Directory, SETTLED_REASON_MAX, type Settled } from "@starbridge/protocol";
import { ApiError } from "../api";
import {
  type Ctx,
  devices,
  iso,
  refreshDirectory,
  type Session,
  session,
  signedHead,
  UsageError,
} from "../context";
import { seal } from "../seal";
import { answerLine, closedHow, named, staleLine } from "./lines";
import { takeUnseen } from "./take";
import { dropRevoked, forget } from "./trust";

/**
 * Closes a decision this machine asked without a Starbridge answer: answered on its `answerIn`
 * page (`elsewhere`), or no longer needed (`withdrawn`). Every device moves it out of the open
 * inbox.
 */
export interface SettleOpts {
  id?: string;
  /** Checked here: it comes from the command line. */
  outcome?: string;
  /** Why the agent withdraws it, which History shows (#1008); required to withdraw one by id. */
  reason?: string;
  /** Every open decision the session asked. */
  session?: string;
  /** Every open decision this machine asked, once `confirm` agrees. */
  all?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Cuts settling one decision by id; none by default, so a settle after Ctrl-C, such as setup's
   * withdrawal of its test question, still goes out (#613).
   */
  deadline?: AbortSignal;
}

export async function settle(ctx: Ctx, opts: SettleOpts): Promise<number> {
  const { id, session: sessionId, all } = opts;
  if ([id, sessionId, all].filter((x) => x).length !== 1)
    throw new UsageError("settle needs a decision id, --session <id> or --all");
  if (opts.outcome !== undefined && opts.outcome !== "elsewhere" && opts.outcome !== "withdrawn")
    throw new UsageError("--outcome is elsewhere or withdrawn");
  const outcome = opts.outcome as "elsewhere" | "withdrawn" | undefined;
  const { reason } = opts;
  if (reason !== undefined) checkReason(reason);
  if (id) {
    const asked = ctx.store.state().asked[id];
    if (!asked) throw new UsageError(`${id} is not a decision this machine asked`);
    const withdrawn = (outcome ?? (asked.answerIn ? "elsewhere" : "withdrawn")) === "withdrawn";
    if (withdrawn && reason === undefined)
      throw new UsageError(
        `say why you withdraw it, in one short line: --reason 'Fixed it myself after rereading the logs'`,
      );
    if (!withdrawn && reason !== undefined)
      throw new UsageError("--reason is for --outcome withdrawn");
    // Closed already, and told to the devices: it says how, and sends nothing (#1697).
    if (asked.settled && !asked.unposted && !ctx.store.state().answers[id]) {
      ctx.err(`starbridge: ${staleLine(ctx.store.state(), id, ctx.now())}`);
      return 0;
    }
    const s = session(ctx);
    const dir = await refreshDirectory(ctx, s, opts.deadline);
    // An answer that came before the settle closed the decision: its session may not have it
    // yet, such as one held for the end of the turn that settles (#1575), so it prints here.
    ctx.store.updateState((st) => void dropRevoked(st, dir));
    const taken = takeUnseen(ctx.store, id);
    if (taken) ctx.out(answerLine(taken.answer, taken.question));
    const settled = await settleOne(ctx, s, dir, id, outcome, false, reason, opts.deadline);
    // Not for one a removed device's answer closed: no answer is held, and `wait` says why.
    if (!settled && ctx.store.state().answers[id])
      ctx.err(`starbridge: ${staleLine(ctx.store.state(), id, ctx.now())}; it stays answered`);
    else if (settled) {
      ctx.err(
        `Settled ${named(id, asked.question)}: ${closedHow(ctx.store.state(), id, ctx.now())}`,
      );
    }
    return 0;
  }
  if (reason !== undefined && outcome !== "withdrawn")
    throw new UsageError("--reason is for --outcome withdrawn");
  return settleMany(ctx, opts, outcome);
}

/**
 * `settle`'s reason for a harness's own question that `outcome` closes: withdrawn, its picker can
 * no longer take the answer.
 */
export function pickerReason(outcome: "elsewhere" | "withdrawn"): { reason?: string } {
  return outcome === "withdrawn" ? { reason: "Its answer could no longer reach the agent" } : {};
}

/** A withdrawal's reason: one line that History shows whole. */
function checkReason(reason: string) {
  if (!reason.trim() || /[\r\n]/.test(reason) || reason.length > SETTLED_REASON_MAX)
    throw new UsageError(`--reason is one line of at most ${SETTLED_REASON_MAX} characters`);
}

/**
 * `settle --session` and `--all`: a flooded account's way out (#584). Each decision is one
 * settled item, posted at the pace the server's 429s set: a machine posts 90 a minute.
 */
async function settleMany(
  ctx: Ctx,
  opts: SettleOpts,
  outcome: "elsewhere" | "withdrawn" | undefined,
): Promise<number> {
  const st = ctx.store.state();
  const open = Object.entries(st.asked)
    // A settle whose notice failed is posted again.
    .filter(([id, a]) => (!a.settled || a.unposted) && !a.revoked && !st.answers[id])
    .filter(([, a]) => opts.all || a.session === opts.session)
    .map(([id]) => id);
  const whose = opts.all ? "this machine asked" : `session ${opts.session} asked`;
  if (open.length === 0) {
    ctx.out(`No open decision ${whose}.`);
    return 0;
  }
  if (opts.all && !(await opts.confirm?.(`Settle all ${open.length} open decisions ${whose}?`)))
    return 1;
  const s = session(ctx);
  const dir = await refreshDirectory(ctx, s);
  let done = 0;
  for (const [i, id] of open.entries()) {
    for (;;) {
      if (ctx.signal?.aborted) {
        ctx.err(`starbridge: stopped after settling ${done} of ${open.length}`);
        return 130;
      }
      try {
        if (await settleOne(ctx, s, dir, id, outcome, true, opts.reason)) done++;
        break;
      } catch (e) {
        if (!(e instanceof ApiError && e.retryAfter)) {
          ctx.err(`starbridge: settled ${done} of ${open.length}; run it again to go on`);
          throw e;
        }
        await ctx.sleep(e.retryAfter * 1000);
      }
    }
    if ((i + 1) % 100 === 0 && i + 1 < open.length) ctx.out(`Settled ${done} of ${open.length}…`);
  }
  ctx.out(`Settled ${done} decision${done === 1 ? "" : "s"}.`);
  return 0;
}

/**
 * Closes decision `id` here, then tells the devices of `dir`; `bulk` for `settleMany`. False
 * when an answer closed it instead.
 */
export async function settleOne(
  ctx: Ctx,
  s: Session,
  dir: Directory,
  id: string,
  outcomeOpt: "elsewhere" | "withdrawn" | undefined,
  bulk = false,
  reason?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const asked = ctx.store.state().asked[id];
  // Closed by a revoked device's answer the server holds: a notice would contradict it. A
  // decision `settle` closed earlier is posted again, in case that post failed.
  if (!asked || asked.revoked) return false;
  const outcome = outcomeOpt ?? (asked.answerIn ? "elsewhere" : "withdrawn");
  // Closed here first: from now on no answer to it is accepted or delivered, even if the post fails.
  // An answer this machine accepted closed it, whether or not its session took it yet (#1575), and
  // a withdrawal would contradict it; checked in the same update, so an answer accepted in
  // another process cannot slip in between.
  let answered = false;
  ctx.store.updateState((st) => {
    answered = !!st.answers[id];
    const a = st.asked[id];
    if (a && !answered) {
      a.settled = true;
      a.unposted = true;
      // The first settle's word stands while its notice is in flight: a second one is refused.
      if (!a.settledAt) {
        a.settledAt = iso(ctx.now());
        a.outcome = outcome;
        if (reason !== undefined && outcome === "withdrawn") a.reason = reason;
      }
      forget(a);
    }
  });
  if (answered) return false;
  const to = devices(ctx, dir);
  const body = {
    v: 1 as const,
    id: `s_${randomBytes(12).toString("base64url")}`,
    itemId: id,
    to: to.map((d) => d.id),
    at: iso(ctx.now()),
    outcome,
    ...(reason !== undefined && outcome === "withdrawn" ? { reason } : {}),
    dir: signedHead(dir),
  } satisfies Settled;
  try {
    await s.api.postItem(
      seal("settled", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to),
      signal,
    );
  } catch (e) {
    // Answered or settled already: either way it is closed, which is what was asked. A bulk run
    // also counts one the server dropped already.
    const code = e instanceof ApiError ? e.code : undefined;
    const closed = ["already-answered", "already-settled", ...(bulk ? ["not-found"] : [])];
    if (!code || !closed.includes(code)) throw e;
  }
  ctx.store.updateState((st) => {
    const a = st.asked[id];
    if (a) delete a.unposted;
  });
  return true;
}
