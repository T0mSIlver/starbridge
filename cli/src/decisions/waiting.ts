import { randomBytes } from "node:crypto";
import type { Waiting } from "@starbridge/protocol";
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
import { answerLine, named, staleLine } from "./lines";
import { poll } from "./poll";
import { snoozedUntil, snoozeLine } from "./snooze";
import { takeUnseen } from "./take";
import { dropRevokedNow } from "./trust";

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
  let last: string | undefined;
  ctx.store.updateState((st) => {
    const a = st.asked[id];
    if (!a) return;
    a.waiting ??= { id: `w_${randomBytes(12).toString("base64url")}`, state: "working" };
    waitingId = a.waiting.id;
    last = a.waiting.at;
  });
  // Devices keep the latest `at`, in whole seconds: a flip within the second of the last one
  // waits for the next second, or they would keep the last one (#1982). It waits rather than
  // stamping ahead of the clock, which a device compares with the owner's snoozes and shows as
  // how long the agent has waited.
  const next = Date.parse(last ?? "") + 1000 || 0;
  const early = next - ctx.now().getTime();
  if (early > 0) await new Promise((r) => setTimeout(r, Math.min(early, 1000)));
  const at = iso(new Date(Math.max(ctx.now().getTime(), next)));
  const dir = await refreshDirectory(ctx, s);
  const to = devices(ctx, dir);
  const body = {
    v: 1 as const,
    id: waitingId,
    decisionId: id,
    to: to.map((d) => d.id),
    at,
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
    if (a) a.waiting = { id: body.id, state, at };
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

/** Marks a decision waiting on the way into a wait; a failure only costs the devices' label. */
export async function markWaiting(ctx: Ctx, post: () => Promise<unknown>): Promise<void> {
  try {
    await post();
  } catch (e) {
    ctx.err(`starbridge: could not mark it waiting: ${(e as Error).message}`);
  }
}
