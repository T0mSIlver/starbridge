import type { Decision, Directory } from "@starbridge/protocol";
import { Interrupted } from "../agent/client";
import { ApiError, Unreachable } from "../api";
import { type Ctx, devices, refreshDirectory, type Session, session, signedHead } from "../context";
import { loadPicture } from "../images";
import { buildDecision, sealWithPictures } from "./build";
import { answerInLine, askLines, delivery, deliveryLine } from "./lines";
import { settleOne } from "./settle";
import { type AskInput, bindSession, resolveSource } from "./source";
import { wait } from "./wait";
import { markWaiting, postWaiting } from "./waiting";

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
        ...(input.nextStep ? { nextStep: input.nextStep } : {}),
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
