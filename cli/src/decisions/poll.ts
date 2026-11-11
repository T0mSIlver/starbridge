import { randomBytes } from "node:crypto";
import { activeMembers, type Directory, type Settled } from "@starbridge/protocol";
import { ApiError } from "../api";
import { type Ctx, iso, refreshDirectory, type Session, signedHead } from "../context";
import { acceptPermissionAnswer } from "../permissions";
import { seal } from "../seal";
import { reseal } from "./reseal";
import { settleOne } from "./settle";
import { acceptSnooze } from "./snooze";
import { behindBy, checkAnswer, dropRevoked, forget, noteHead, refuse } from "./trust";

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
  await resettle(ctx, s, directory);
  // A device that joined since reads nothing this machine sealed before: re-seal it.
  await reseal(ctx, s, directory).catch((e) =>
    ctx.err(`starbridge: could not re-send open questions: ${(e as Error).message}`),
  );
  return { cursor: page.cursor ?? opts.cursor, directory, ...quotaAsked };
}

/** When each settled notice whose post failed may go again, in this process. */
const retryAt = new Map<string, { at: number; wait: number }>();
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
const RETRY_POST_MS = 5_000;
/**
 * Past `post.ts`'s deadline for the post and its withdrawal, with room to spare: a record still
 * `posting` then belongs to a process killed mid-post.
 */
const POSTING_MS = 120_000;

/**
 * Posts again the settled notice of each decision settled here whose post failed, such as the
 * withdrawal after a post that lost its reply (#1289): otherwise its card stays open on the
 * devices and their answer is refused here. Each retry waits twice as long as the last, up to an
 * hour.
 */
async function resettle(ctx: Ctx, s: Session, dir: Directory): Promise<void> {
  failKilledPosts(ctx);
  const st = ctx.store.state();
  if (st.behind) return;
  const now = Date.now();
  const due = Object.entries(st.asked).filter(
    ([id, a]) =>
      a.settled &&
      a.unposted &&
      !a.posting &&
      !a.revoked &&
      !st.answers[id] &&
      (retryAt.get(id)?.at ?? 0) <= now,
  );
  for (const [id, a] of due) {
    try {
      // `bulk`: a server that dropped the decision, or never stored it, has nothing to close.
      // Bounded, as `post.ts`'s first try: a server that never replies must not hold the poll.
      const deadline = AbortSignal.timeout(RETRY_POST_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
      await settleOne(ctx, s, dir, id, a.outcome, true, a.reason, signal);
      retryAt.delete(id);
    } catch (e) {
      const wait = Math.min((retryAt.get(id)?.wait ?? RETRY_MIN_MS / 2) * 2, RETRY_MAX_MS);
      retryAt.set(id, { at: now + wait, wait });
      // Offline or cut off: the rest would fail the same way.
      if (!(e instanceof ApiError)) return;
    }
  }
}

/**
 * Settles a question whose `ask` was killed mid-post (SIGKILL, out of memory), as a failed post:
 * withdrawn and its notice owed, so `resettle` closes its card if the post did land. Otherwise it
 * shows as open for a month, and is never pruned or re-sealed. One already answered did land: it
 * is only marked posted.
 */
function failKilledPosts(ctx: Ctx): void {
  const now = ctx.now().getTime();
  const stale = (a: { posting?: boolean; askedAt: string }) =>
    a.posting && now - Date.parse(a.askedAt) > POSTING_MS;
  if (!Object.values(ctx.store.state().asked).some(stale)) return;
  ctx.store.updateState((st) => {
    for (const [id, a] of Object.entries(st.asked)) {
      if (!stale(a)) continue;
      delete a.posting;
      if (st.answers[id] || a.settled) continue;
      a.settled = true;
      a.unposted = true;
      a.settledAt = iso(ctx.now());
      a.outcome = "withdrawn";
      forget(a);
    }
  });
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
