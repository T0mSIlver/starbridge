import { activeMembers, type Directory, type SealedItem, type Waiting } from "@starbridge/protocol";
import { ApiError } from "../api";
import { type Ctx, iso, refreshDirectory, type Session, signedHead } from "../context";
import { seal } from "../seal";
import { forget } from "./trust";

/** The server drops an unanswered decision after 30 days; one re-sealed later would come back. */
export const RESEAL_MS = 29 * 24 * 3600_000;

/**
 * When each store's re-seal may run again after a 429: until then the machine's rate window is
 * left to its own asks (#650).
 */
const resealPaused = new WeakMap<object, number>();

/**
 * Re-seals this machine's open decisions, with their waiting state, and permission prompts to
 * the active devices of the verified directory when one of those was not among their
 * recipients. They keep their ids, so a device that had them sees no second copy, and the server
 * pushes only the new devices. Revoked devices get nothing, and nothing is re-sealed while the
 * server may be withholding directory entries.
 */
export async function reseal(ctx: Ctx, s: Session, known: Directory): Promise<void> {
  const st = ctx.store.state();
  const now = ctx.now().getTime();
  if ((resealPaused.get(ctx.store) ?? 0) > now) return;
  // A decision's recipients are those of its body as last posted; `to`, whose answers count, may
  // hold more: a post whose reply was lost could have reached the server.
  const decisions = Object.entries(st.asked).flatMap(([id, a]) =>
    a.body &&
    a.to &&
    !a.posting &&
    !a.settled &&
    !st.answers[id] &&
    now - Date.parse(a.askedAt) < RESEAL_MS
      ? [{ id, a, body: a.body }]
      : [],
  );
  const prompts = Object.values(st.permissions ?? {}).filter(
    (p) => !p.settled && !p.answer && Date.parse(p.permission.expiresAt) > now,
  );
  const lacking = (to: string[], dir: Directory) =>
    activeMembers(dir, "device").some((d) => !to.includes(d.id));
  const all = [
    ...decisions.map((d) => d.body.to),
    ...prompts.map((p) => p.sealedTo ?? p.permission.to),
  ];
  if (st.behind || !all.some((to) => lacking(to, known))) return;
  const dir = await refreshDirectory(ctx, s, ctx.signal);
  const to = activeMembers(dir, "device");
  const ids = to.map((d) => d.id);
  const signer = { id: s.machine.id, signKey: s.keys.sign.privateKey };
  /**
   * Posts a re-sealed item: "posted", "closed" when the server holds it answered or no longer
   * holds it, "limited" after a 429, which pauses the re-seal for its Retry-After, or undefined
   * after another error. The next poll tries the rest again.
   */
  const post = async (item: () => SealedItem) => {
    let sealed: SealedItem | undefined;
    try {
      sealed = item();
      await s.api.postItem(sealed);
      return "posted";
    } catch (e) {
      if (e instanceof ApiError && ["already-answered", "not-found"].includes(e.code))
        return "closed";
      // Too large for this many devices, as on a server with a lower cap: it can never reach them.
      if (e instanceof ApiError && e.code === "too-large") {
        ctx.err(
          `starbridge: ${sealed?.id ?? ""} is too large to send to the new devices; it stays on the others`,
        );
        return "closed";
      }
      if (e instanceof ApiError && e.status === 429) {
        resealPaused.set(ctx.store, ctx.now().getTime() + (e.retryAfter ?? 60) * 1000);
        return "limited";
      }
      ctx.err(`starbridge: could not re-send ${sealed?.id ?? ""}: ${(e as Error).message}`);
    }
  };
  for (const { id, a, body } of decisions) {
    if (!lacking(body.to, dir)) continue;
    ctx.store.updateState((st) => {
      const x = st.asked[id];
      if (x) x.to = [...new Set([...x.to, ...ids])];
    });
    // Without blobs: the server keeps the images, sealed once for every device (#685).
    const posted = await post(() => ({
      ...seal("decision", { ...body, to: ids, dir: signedHead(dir) }, signer, to),
      reseal: true,
    }));
    if (posted === "closed")
      ctx.store.updateState((st) => {
        const x = st.asked[id];
        if (x) forget(x);
      });
    if (posted === "limited") return;
    if (posted !== "posted") continue;
    // Done once its waiting state went too; else the next poll re-sends both.
    if (a.waiting?.state === "waiting") {
      const w = {
        v: 1 as const,
        id: a.waiting.id,
        decisionId: id,
        to: ids,
        at: iso(ctx.now()),
        state: a.waiting.state,
        dir: signedHead(dir),
      } satisfies Waiting;
      const sent = await post(() => ({ ...seal("waiting", w, signer, to), quiet: true }));
      if (sent === "limited") return;
      if (!sent) continue;
    }
    ctx.store.updateState((st) => {
      const x = st.asked[id];
      if (x?.body) x.body.to = ids;
    });
  }
  for (const p of prompts) {
    if (!lacking(p.sealedTo ?? p.permission.to, dir)) continue;
    const permission = { ...p.permission, to: ids, dir: signedHead(dir) };
    // As for decisions: answers count from the new devices before the post. `sealedTo` keeps the
    // devices that hold it, so a failed post is tried again on the next poll.
    ctx.store.updateState((st) => {
      const x = st.permissions?.[permission.id];
      if (!x) return;
      x.sealedTo ??= x.permission.to;
      x.permission.to = [...new Set([...x.permission.to, ...ids])];
    });
    // Closed: answered or gone on the server, so no device needs it any more.
    const sent = await post(() => ({
      ...seal("permission", permission, signer, to),
      reseal: true,
    }));
    if (sent === "limited") return;
    if (sent === undefined) continue;
    ctx.store.updateState((st) => {
      const x = st.permissions?.[permission.id];
      if (x) x.sealedTo = ids;
    });
  }
}
