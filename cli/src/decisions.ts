import { randomBytes } from "node:crypto";
import {
  type Answer,
  activeMembers,
  type Decision,
  type Directory,
  ProtocolError,
  SETTLED_REASON_MAX,
  type Settled,
  type Waiting,
} from "@starbridge/protocol";
import { Interrupted } from "./agent/client";
import { ApiError, Unreachable } from "./api";
import type { State } from "./config";
import {
  type Ctx,
  devices,
  iso,
  parseDuration,
  refreshDirectory,
  type Session,
  session,
  signedHead,
  UsageError,
} from "./context";
import { buildDecision, sealWithPictures } from "./decisions/build";
import {
  answerInLine,
  answerLine,
  askLines,
  closedError,
  closedHow,
  delivery,
  deliveryLine,
  named,
  printAnswer,
  staleLine,
} from "./decisions/lines";
import { RESEAL_MS, reseal } from "./decisions/reseal";
import {
  acceptSnooze,
  printSnooze,
  snoozedUntil,
  snoozeLine,
  takeSnooze,
} from "./decisions/snooze";
import { type AskInput, bindSession, resolveSource } from "./decisions/source";
import {
  behindBy,
  checkAnswer,
  dropRevoked,
  dropRevokedNow,
  forget,
  noteHead,
  refuse,
} from "./decisions/trust";
import { loadPicture } from "./images";
import { acceptPermissionAnswer } from "./permissions";
import { seal } from "./seal";

export { ASK_LIMITS, buildDecision, typedBreaks } from "./decisions/build";
export {
  answerInLine,
  answerLine,
  answerPrefix,
  askLines,
  closedError,
  closedHow,
  type Delivery,
  DONE_LINE,
  delivery,
  deliveryLine,
  hooklessLine,
  MOD_SEEN_MS,
  named,
  pastTime,
  staleLine,
} from "./decisions/lines";
export { RESEAL_MS } from "./decisions/reseal";
export {
  acceptSnooze,
  printSnooze,
  snoozedUntil,
  snoozeLine,
  snoozeTime,
  takeSnooze,
} from "./decisions/snooze";
export { type AskInput, bindSession, resolveSource } from "./decisions/source";
export { behindBy, checkAnswer, dropRevokedNow, noteHead } from "./decisions/trust";

/** Exit code when nobody answered before `--timeout`. */
export const EXIT_TIMEOUT = 2;
/** `wait <id>`'s exit code when the owner snoozed the decision (#571): no answer before then. */
export const EXIT_SNOOZED = 3;
/** Exit code on Ctrl-C, as a shell reports SIGINT. */
export const EXIT_INTERRUPTED = 130;
/** The server holds a long-poll at most this long (PROTOCOL.md). */
const MAX_POLL_SECONDS = 300;
/** Pause before retrying after a network or server error. */
const RETRY_MS = 5_000;
/**
 * How long a decision's post may take, its images included: a server that takes the connection
 * and never answers would otherwise hold `ask` for ever, past SIGTERM (#1288).
 */
const POST_MS = 60_000;
/** How long the withdrawal of a decision whose post failed may take. */
const WITHDRAW_MS = 5_000;

/**
 * Seals the decision to every active device, posts it and records it in the state, so its
 * answer reaches the session that asked. Returns the decision. A post cut short is settled, as
 * the server may hold it: `elsewhere` once `answered` is aborted (a harness's picker answered
 * at the keyboard, #1913), otherwise withdrawn.
 */
export async function postDecision(
  ctx: Ctx,
  s: Session,
  input: AskInput,
  answered?: AbortSignal,
): Promise<Decision> {
  const deadline = AbortSignal.timeout(POST_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
  // Ctrl-C exits 130, as everywhere (CONTRACT.md); the deadline says what it cut.
  const cut = (e: unknown) =>
    ctx.signal?.aborted
      ? new Interrupted()
      : deadline.aborted
        ? new Unreachable(`the server did not take the question within ${POST_MS / 1000} s`)
        : e;
  let dir: Directory;
  try {
    dir = await refreshDirectory(ctx, s, signal);
  } catch (e) {
    throw cut(e);
  }
  const pictures = (input.images ?? []).map((i) =>
    typeof i === "string" ? loadPicture(i) : loadPicture(i.path, i.alt),
  );
  const to = devices(ctx, dir);
  // A new id that an earlier decision of the account already holds is refused (409); mint again.
  for (let tries = 1; ; tries++) {
    const base = {
      ...buildDecision(
        input,
        ctx,
        s.machine.name,
        to.map((d) => d.id),
      ),
      dir: signedHead(dir),
    };
    const { decision, item } = sealWithPictures(
      base,
      pictures,
      { id: s.machine.id, signKey: s.keys.sign.privateKey },
      to,
    );
    // A wait for this decision starts at the cursor known now, so it never misses its answer.
    const cursor = ctx.store.state().cursor;
    // Asked already waiting, its waiting state pushes instead, so the notification says so.
    let minted = false;
    ctx.store.updateState((st) => {
      // An id this machine already holds is another question's: mint again, keeping its record.
      if (st.asked[decision.id]) return;
      minted = true;
      st.asked[decision.id] = {
        question: decision.question,
        options: decision.options,
        askedAt: decision.createdAt,
        to: decision.to,
        body: decision,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(decision.source.session && !input.held ? { session: decision.source.session } : {}),
        ...(decision.source.sessionTitle ? { sessionTitle: decision.source.sessionTitle } : {}),
        project: decision.source.project,
        ...(decision.answerIn ? { answerIn: true } : {}),
        ...(decision.done ? { done: true } : {}),
        ...(input.codex && decision.source.session ? { codex: input.codex } : {}),
        ...(input.antigravity && decision.source.session ? { antigravity: input.antigravity } : {}),
        ...(input.extensionAnswers && decision.source.session ? { extensionAnswers: true } : {}),
        ...(input.held ? { held: true } : {}),
        ...(input.picker ? { picker: input.picker } : {}),
        ...(input.subagent && decision.source.session && !input.held
          ? { subagent: input.subagent }
          : {}),
        // Recorded before the post: the server may hand out its answer before it replies.
        posting: true,
      };
    });
    if (!minted) {
      if (tries < 4) continue;
      throw new Error(`could not mint a new decision id`);
    }
    const posted = () =>
      ctx.store.updateState((st) => {
        delete st.asked[decision.id]?.posting;
      });
    try {
      await s.api.postItem(input.waiting ? { ...item, quiet: true } : item, signal);
    } catch (e) {
      // Refused: the server stored nothing. Otherwise it may have stored the decision before the
      // reply was lost (#1289): withdrawn, or its card stays open on the devices and its answer
      // finds no decision here. A server that never got it refuses this, which changes nothing.
      if (e instanceof ApiError && e.status < 500)
        ctx.store.updateState((st) => {
          delete st.asked[decision.id];
        });
      if (e instanceof ApiError && e.code === "duplicate-id" && tries < 4) continue;
      if (!(e instanceof ApiError) || e.status >= 500) {
        posted();
        // Settled while it posted, its own word stands.
        const a = ctx.store.state().asked[decision.id];
        await settleOne(
          { ...ctx, signal: undefined },
          s,
          dir,
          decision.id,
          a?.settled ? a.outcome : answered?.aborted ? "elsewhere" : "withdrawn",
          false,
          a?.settled ? a.reason : undefined,
          AbortSignal.timeout(WITHDRAW_MS),
        ).catch(() => {});
      }
      throw cut(e);
    }
    posted();
    // Settled while it posted, as by `settle --all`: that notice may have reached the server
    // first and closed nothing, so it goes again now that the server holds the question.
    const a = ctx.store.state().asked[decision.id];
    if (a?.settled && !a.revoked && !ctx.store.state().answers[decision.id]) {
      await settleOne(
        { ...ctx, signal: undefined },
        s,
        dir,
        decision.id,
        a.outcome,
        false,
        a.reason,
        AbortSignal.timeout(WITHDRAW_MS),
      ).catch(() => {});
      return decision;
    }
    if (input.waiting) await markWaiting(ctx, () => postWaiting(ctx, s, decision.id, "waiting"));
    return decision;
  }
}

/**
 * Posts a decision and prints its id; with `wait`, then waits for its answer. `answered` is
 * `postDecision`'s: aborted, a post it cuts is settled elsewhere.
 */
export async function ask(
  ctx: Ctx,
  asked: AskInput,
  opts: { wait?: boolean; timeout?: string; json?: boolean; answered?: AbortSignal },
): Promise<number> {
  const s = session(ctx);
  const { input, warning } = bindSession(asked, ctx.env);
  const resolved = resolveSource(input, ctx.env, process.cwd());
  const decision = await postDecision(
    ctx,
    s,
    { ...resolved, waiting: input.waiting || opts.wait },
    opts.answered,
  );
  ctx.out(decision.id);
  if (warning) ctx.err(warning);
  // With no agent, nothing tells which sessions run a mod: the poller's lease says only that one
  // does (#537).
  if (!opts.wait) {
    const d = delivery(resolved, false, false);
    ctx.err(deliveryLine(decision.id, d));
    for (const line of askLines(resolved, d, ctx.env)) ctx.err(line);
  }
  if (input.answerIn !== undefined) ctx.err(answerInLine(decision.id));
  if (!opts.wait) return 0;
  return wait(ctx, { id: decision.id, timeout: opts.timeout, json: opts.json }, s);
}

/**
 * Posts decision `id`'s waiting state under the one id it keeps. Only a flip to `waiting`
 * pushes; posting the state it already has does nothing. Returns whether it
 * posted. A decision answered meanwhile throws a UsageError saying so.
 */
export async function postWaiting(
  ctx: Ctx,
  s: Session,
  id: string,
  state: Waiting["state"],
): Promise<boolean> {
  const asked = ctx.store.state().asked[id];
  if (!asked) throw new UsageError(`${id} is not a decision this machine asked`);
  if (ctx.store.state().answers[id] || asked.settled)
    throw new UsageError(staleLine(ctx.store.state(), id, ctx.now()));
  if ((asked.waiting?.state ?? "working") === state) return false;
  // The id is kept before the first post, so a lost reply or a second process reuses it.
  let waitingId = "";
  ctx.store.updateState((st) => {
    const a = st.asked[id];
    if (!a) return;
    a.waiting ??= { id: `w_${randomBytes(12).toString("base64url")}`, state: "working" };
    waitingId = a.waiting.id;
  });
  const dir = await refreshDirectory(ctx, s);
  const to = devices(ctx, dir);
  const body = {
    v: 1 as const,
    id: waitingId,
    decisionId: id,
    to: to.map((d) => d.id),
    at: iso(ctx.now()),
    state,
    dir: signedHead(dir),
  } satisfies Waiting;
  const item = seal("waiting", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to);
  try {
    // Both flips push: a phone moves the question's notification between its channels (#191).
    await s.api.postItem(item);
  } catch (e) {
    if (e instanceof ApiError && e.code === "already-answered")
      throw new UsageError(`${named(id, asked.question)} was already answered`);
    throw e;
  }
  ctx.store.updateState((st) => {
    const a = st.asked[id];
    if (a) a.waiting = { id: body.id, state };
  });
  return true;
}

/** `starbridge waiting <id>` and `starbridge working <id>`. */
export async function setWaiting(
  ctx: Ctx,
  opts: { id?: string; state: Waiting["state"] },
): Promise<number> {
  if (!opts.id) throw new UsageError(`${opts.state} needs a decision id`);
  // A revoked device's answer is dropped first, as every hand-out does (#491).
  if (opts.state === "waiting") await dropRevokedNow(ctx);
  const taken = opts.state === "waiting" ? takeUnseen(ctx.store, opts.id) : undefined;
  if (taken) {
    ctx.out(answerLine(taken.answer, taken.question));
    return 0;
  }
  const s = session(ctx);
  await postWaiting(ctx, s, opts.id, opts.state);
  // Without the agent nothing polls meanwhile: read every page since the question was asked,
  // so the owner's latest snooze is among them.
  if (opts.state === "waiting") {
    let cursor = ctx.store.state().asked[opts.id]?.cursor;
    for (let page = 0; page < 100; page++) {
      const next = (await poll(ctx, s, { cursor, seconds: 0, shared: false })).cursor;
      if (next === cursor) break;
      cursor = next;
    }
  }
  const until = snoozedUntil(ctx.store.state(), opts.id, ctx.now());
  if (until && opts.state === "waiting")
    ctx.out(snoozeLine(opts.id, ctx.store.state().asked[opts.id]?.question, until, ctx.now()));
  return 0;
}

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
async function settleOne(
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

/**
 * Whether decision `id`'s answer may reach its session: not settled, taking answers (a Done for
 * one answered on its own page), and the machine not behind on the directory.
 */
export function deliverable(st: State, id: string): boolean {
  const asked = st.asked[id];
  return !!asked && !asked.settled && (!asked.answerIn || !!asked.done) && !st.behind;
}

/** Held items other than answers to open questions and prompts, at most, while the directory is behind. */
const HELD_MAX = 100;

/**
 * One long-poll for answers from `cursor`: keeps the verified ones in the state, and with
 * `shared` moves the shared cursor unless another process moved it meanwhile. Throws on a
 * network or server error, leaving the cursor where it was so a retry fetches the same answers.
 */
export async function poll(
  ctx: Ctx,
  s: Session,
  opts: {
    cursor?: string;
    seconds: number;
    shared: boolean;
    directory?: Directory;
    /**
     * The agent's poll also returns when a device joins or asks for quotas (PROTOCOL.md,
     * "Answers for machines"); `quotaAsked` is the last ask the server reported.
     */
    watch?: { quotaAsked?: string };
  },
): Promise<{ cursor?: string; directory: Directory; quotaAsked?: string }> {
  // `ctx.signal` cuts every request: Ctrl-C, or a hook's deadline.
  let directory = opts.directory ?? (await refreshDirectory(ctx, s, ctx.signal));
  const page = await s.api.answers(
    opts.cursor,
    opts.seconds,
    ctx.signal,
    opts.watch && { directory: directory.length, ...opts.watch },
  );
  const quotaAsked = page.quotaAsked !== undefined ? { quotaAsked: page.quotaAsked } : {};
  if (page.items.length === 0 && (page.directory ?? 0) > directory.length)
    directory = await refreshDirectory(ctx, s, ctx.signal);
  const before = ctx.store.state();
  if (page.items.length > 0 || before.held?.length || before.behind) {
    // A new device may have answered since the directory was read.
    directory = await refreshDirectory(ctx, s, ctx.signal);
    const dir = directory;
    const entries = ctx.store.directory();
    ctx.store.updateState((st) => {
      // Two processes polling from their own cursors fetch the same items: keep one of each.
      const ids = new Set<unknown>();
      const items = [...(st.held ?? []), ...page.items].filter((raw) => {
        const id = (raw as { id?: unknown } | null)?.id;
        if (id === undefined) return true;
        if (ids.has(id)) return false;
        ids.add(id);
        return true;
      });
      delete st.held;
      // Every head first: a withheld entry any answer names holds back the whole page.
      const signers = new Map(items.map((raw) => [raw, noteHead(raw, s, dir, entries, st)]));
      // Snoozes wait with the answers (#571): a device's word, to read once nothing is withheld.
      const answers = items.filter(
        (raw) =>
          signers.get(raw) !== undefined || (raw as { kind?: unknown } | null)?.kind === "snooze",
      );
      const behind = behindBy(st, dir, entries);
      if (behind) {
        // Kept, not dropped: the device's client counts them sent, and the server takes no other.
        st.behind = behind;
        // Every answer to a question or permission prompt still open here: the cursor moved
        // past it, and the server takes no other (#1976). Devices sign each, so their number is
        // bounded by those; the rest, such as snoozes, keep the latest.
        const due = (raw: unknown) => {
          const r = raw as { kind?: unknown; re?: unknown } | null;
          if (typeof r?.re !== "string") return false;
          if (r.kind === "answer" && Object.hasOwn(st.asked, r.re))
            return !st.asked[r.re]?.settled && !st.answers[r.re];
          const prompt =
            st.permissions && Object.hasOwn(st.permissions, r.re) && st.permissions[r.re];
          return r.kind === "permission-answer" && !!prompt && !prompt.answer && !prompt.settled;
        };
        const rest = new Set(answers.filter((raw) => !due(raw)).slice(-HELD_MAX));
        st.held = answers.filter((raw) => due(raw) || rest.has(raw));
        ctx.err(`starbridge: holding ${st.held.length} answers: ${behind}`);
      } else {
        delete st.behind;
        dropRevoked(st, dir);
        for (const raw of items) {
          try {
            // Machines' inboxes hold answers to decisions and to permission prompts (#57), and
            // the owner's snoozes (#571).
            if ((raw as { kind?: unknown } | null)?.kind === "snooze") {
              acceptSnooze(raw, s, dir, st);
              continue;
            }
            if ((raw as { kind?: unknown } | null)?.kind === "permission-answer") {
              const { answer, device } = acceptPermissionAnswer(raw, s, dir, st, Date.now());
              const p = st.permissions?.[answer.permissionId];
              if (p) p.answer = { ...answer, device };
              continue;
            }
            const a = checkAnswer(raw, s, dir, st.asked);
            const device = signers.get(raw);
            st.answers[a.decisionId] ??= {
              answer: a,
              seen: false,
              ...(device ? { device, announce: true } : {}),
            };
            const asked = st.asked[a.decisionId];
            if (asked) forget(asked);
          } catch (e) {
            ctx.err(`starbridge: ignored an answer: ${(e as Error).message}`);
            refuse(raw, e, s, dir, st);
          }
        }
      }
      if (opts.shared && st.cursor === opts.cursor && page.cursor !== undefined)
        st.cursor = page.cursor;
    });
  } else {
    // A revocation brings no answer, but voids those still waiting for their session (#491).
    // `before` is a fresh read, so trying on it costs no write when nothing is dropped.
    const dir = directory;
    if (dropRevoked(before, dir)) ctx.store.updateState((st) => dropRevoked(st, dir));
  }
  await announce(ctx, s, directory);
  // A device that joined since reads nothing this machine sealed before: re-seal it.
  await reseal(ctx, s, directory).catch((e) =>
    ctx.err(`starbridge: could not re-send open questions: ${(e as Error).message}`),
  );
  return { cursor: page.cursor ?? opts.cursor, directory, ...quotaAsked };
}

/**
 * Tells every device which answer this machine accepted, in a settled notice: the answer itself
 * is sealed only to this machine, so a device that lost a race to it could not know (#330).
 * Left to the next poll when the post fails.
 */
async function announce(ctx: Ctx, s: Session, dir: Directory): Promise<void> {
  const st = ctx.store.state();
  // Behind on the directory, it would seal to a device the server knows revoked: later.
  if (st.behind) return;
  const due = Object.entries(st.answers).filter(([, a]) => a.announce && a.device);
  if (due.length === 0) return;
  // No active device left: nobody to tell.
  const to = activeMembers(dir, "device");
  for (const [id, { answer, device }] of due) {
    const body = {
      v: 1 as const,
      id: `s_${randomBytes(12).toString("base64url")}`,
      itemId: id,
      to: to.map((d) => d.id),
      at: iso(ctx.now()),
      outcome: "device" as const,
      device: device as string,
      // A Done repeats nothing: devices read a device's notice without either as one.
      ...(answer.choice !== undefined
        ? { choice: answer.choice }
        : answer.text !== undefined
          ? { text: answer.text }
          : {}),
      dir: signedHead(dir),
    } satisfies Settled;
    try {
      if (to.length > 0)
        await s.api.postItem(
          seal("settled", body, { id: s.machine.id, signKey: s.keys.sign.privateKey }, to),
          ctx.signal,
        );
    } catch (e) {
      // Settled already (withdrawn meanwhile, say) or gone: nothing left to tell.
      const done = e instanceof ApiError && (e.code === "already-settled" || e.status === 404);
      if (!done) {
        ctx.err(`starbridge: could not tell the devices which answer won: ${(e as Error).message}`);
        // Offline or cut off by a deadline: the rest would fail the same way.
        if (!(e instanceof ApiError)) return;
        continue;
      }
    }
    ctx.store.updateState((st) => {
      const a = st.answers[id];
      if (a) delete a.announce;
    });
  }
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

/**
 * Waits for the answer to decision `id`, marking it `waiting`, or without `id` for the next
 * answer to any decision this machine asked. Exits 0 with the answer, or EXIT_TIMEOUT once
 * `--timeout` passes.
 */
export async function wait(
  ctx: Ctx,
  opts: { id?: string; session?: string; timeout?: string; json?: boolean; "no-mark"?: boolean },
  s: Session = session(ctx),
  dir?: Directory,
): Promise<number> {
  const state = ctx.store.state();
  const target = opts.id;
  if (target && !state.asked[target])
    throw new UsageError(`${target} is not a decision this machine asked`);
  const closed = () => closedError(ctx, target);

  const report = (found: { answer: Answer; question?: string }) => {
    printAnswer(ctx, found.answer, found.question, opts.json);
    return 0;
  };
  // Snoozed: said once, so a polling agent stops; the next `wait` waits on (#571).
  const snoozed = () => {
    const until = target ? takeSnooze(ctx.store, target, ctx.now()) : undefined;
    if (!until || !target) return undefined;
    printSnooze(ctx, target, ctx.store.state().asked[target]?.question, until, opts.json);
    return EXIT_SNOOZED;
  };

  await dropRevokedNow(ctx);
  const shut = closed();
  if (shut) throw shut;
  const already = takeAnswer(ctx.store, target, opts.session);
  if (already) return report(already);
  if (target && !opts["no-mark"])
    await markWaiting(ctx, () => postWaiting(ctx, s, target, "waiting"));
  // A snooze is told only after a poll: the one cached may be over, or answered since.

  let deadline = Number.POSITIVE_INFINITY;
  if (opts.timeout) deadline = ctx.now().getTime() + parseDuration(opts.timeout);

  // A wait for one decision reads from where that decision was asked; a wait for any answer
  // reads from, and moves, the shared cursor.
  let cursor = target ? state.asked[target]?.cursor : state.cursor;
  let directory = dir;
  while (true) {
    const left = deadline - ctx.now().getTime();
    if (ctx.signal?.aborted) return EXIT_INTERRUPTED;
    if (left <= 0) {
      ctx.err(
        `No answer to ${target ? named(target, state.asked[target]?.question) : "any decision"} yet.`,
      );
      return EXIT_TIMEOUT;
    }
    try {
      const seconds = Math.max(1, Math.min(MAX_POLL_SECONDS, Math.ceil(left / 1000)));
      ({ cursor, directory } = await poll(ctx, s, {
        cursor,
        seconds,
        shared: !target,
        directory,
      }));
    } catch (e) {
      if (e instanceof UsageError || e instanceof ProtocolError) throw e;
      if (ctx.signal?.aborted) continue;
      ctx.err(`starbridge: ${(e as Error).message}; retrying`);
      await ctx.sleep(Math.min(RETRY_MS, Math.max(0, left)));
      continue;
    }
    const found = takeAnswer(ctx.store, target, opts.session);
    if (found) return report(found);
    const ended = closed();
    if (ended) throw ended;
    const off = snoozed();
    if (off !== undefined) return off;
  }
}

/** Marks a decision waiting on the way into a wait; a failure only costs the devices' label. */
export async function markWaiting(ctx: Ctx, post: () => Promise<unknown>): Promise<void> {
  try {
    await post();
  } catch (e) {
    ctx.err(`starbridge: could not mark it waiting: ${(e as Error).message}`);
  }
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

/** How long each server poll of `answers --all --follow` holds. */
const FOLLOW_POLL_SECONDS = 30;

/** One line of `answers --all`: an answer to a decision this machine asked, with who asked. */
export interface ObservedAnswer {
  decisionId: string;
  question: string;
  choice?: string;
  text?: string;
  done?: true;
  answeredAt: string;
  session?: string;
  sessionTitle?: string;
  project?: string;
}

/**
 * Every answer the machine accepted, oldest first, from `since` (ms) on and leaving out the
 * decision ids in `known`: one whose decision was settled since stays, since it is still the
 * owner's word (#1575). Reads only: nothing is marked seen, so the session that asked still gets
 * each one.
 */
export function observedAnswers(
  st: State,
  opts: { since?: number; known?: ReadonlySet<string> } = {},
): ObservedAnswer[] {
  if (st.behind) return [];
  const lines: ObservedAnswer[] = [];
  for (const [id, { answer }] of Object.entries(st.answers)) {
    const asked = st.asked[id];
    if (!asked || (asked.answerIn && !asked.done) || opts.known?.has(id)) continue;
    if (opts.since !== undefined && Date.parse(answer.answeredAt) < opts.since) continue;
    const { session, sessionTitle, project } = asked;
    lines.push({
      decisionId: id,
      question: asked.question,
      ...(answer.choice !== undefined ? { choice: answer.choice } : {}),
      ...(answer.text !== undefined ? { text: answer.text } : {}),
      ...(answer.done ? { done: true as const } : {}),
      answeredAt: answer.answeredAt,
      ...(session ? { session } : {}),
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(project !== undefined ? { project } : {}),
    });
  }
  return lines.sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));
}

/** `--since`: a time (`2026-10-06T21:00Z`), or a duration with its unit back from now (`2h`). */
export function sinceTime(text: string, now: Date): number {
  if (/^\d+(\.\d+)?\s*[smhd]$/.test(text.trim())) return now.getTime() - parseDuration(text);
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new UsageError(`--since takes a time or a duration, not ${text}`);
  return t;
}

/**
 * `answers --all` with no agent: prints every answer `observedAnswers` holds, then with `follow`
 * polls the server from a cursor of its own, never the shared one, and prints each new answer
 * until interrupted. `printed` carries over from an agent that stopped under it.
 */
export async function answersAll(
  ctx: Ctx,
  opts: { follow?: boolean; since?: number },
  printed: Set<string> = new Set(),
): Promise<number> {
  const flush = () => {
    for (const a of observedAnswers(ctx.store.state(), { since: opts.since, known: printed })) {
      printed.add(a.decisionId);
      ctx.out(JSON.stringify(a));
    }
  };
  const s = session(ctx);
  let cursor = ctx.store.state().cursor;
  let directory: Directory | undefined;
  // Nothing else may have fetched the server's answers yet: one poll that returns at once.
  try {
    ({ cursor, directory } = await poll(ctx, s, { cursor, seconds: 0, shared: false }));
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProtocolError) throw e;
    if (!ctx.signal?.aborted)
      ctx.err(`starbridge: ${(e as Error).message}; printing what this machine has`);
  }
  if (ctx.signal?.aborted) return EXIT_INTERRUPTED;
  flush();
  if (!opts.follow) return 0;
  while (!ctx.signal?.aborted) {
    try {
      ({ cursor, directory } = await poll(ctx, s, {
        cursor,
        // Short holds: another process may release answers this poll never fetches.
        seconds: FOLLOW_POLL_SECONDS,
        shared: false,
        directory,
      }));
    } catch (e) {
      if (e instanceof UsageError || e instanceof ProtocolError) throw e;
      if (ctx.signal?.aborted) break;
      ctx.err(`starbridge: ${(e as Error).message}; retrying`);
      directory = undefined;
      await ctx.sleep(RETRY_MS);
      continue;
    }
    // The agent or a `wait` may have accepted answers this poll did not fetch.
    flush();
  }
  return EXIT_INTERRUPTED;
}

/** One line of `decisions --open`: a question this machine asked that is still open. */
export interface OpenDecision {
  decisionId: string;
  question: string;
  options: string[];
  askedAt: string;
  waiting: boolean;
  session?: string;
  sessionTitle?: string;
  project?: string;
}

/**
 * The questions this machine asked that have no answer yet, are not settled and the server still
 * holds (it drops them after 30 days), oldest first. Questions a hook waits on itself are left
 * out: no session owns them.
 */
export function openDecisions(st: State, now: Date): OpenDecision[] {
  const lines: OpenDecision[] = [];
  for (const [id, a] of Object.entries(st.asked)) {
    if (a.settled || a.held || st.answers[id]) continue;
    if (now.getTime() - Date.parse(a.askedAt) >= RESEAL_MS) continue;
    lines.push({
      decisionId: id,
      question: a.question,
      options: a.options,
      askedAt: a.askedAt,
      waiting: a.waiting?.state === "waiting",
      ...(a.session ? { session: a.session } : {}),
      ...(a.sessionTitle ? { sessionTitle: a.sessionTitle } : {}),
      ...(a.project !== undefined ? { project: a.project } : {}),
    });
  }
  return lines.sort((x, y) => x.askedAt.localeCompare(y.askedAt));
}

/** `decisions --open`: prints `openDecisions` as JSON lines, from the state file both paths share. */
export function decisionsOpen(ctx: Ctx): number {
  for (const d of openDecisions(ctx.store.state(), ctx.now())) ctx.out(JSON.stringify(d));
  return 0;
}
