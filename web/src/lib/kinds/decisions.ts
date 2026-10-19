// Decisions: the questions machines' agents ask, read into the inbox with the notices that tell
// their state (waiting, snoozed, settled), kept sealed in IndexedDB (#1380), and answered.
import {
  activeMembers,
  type Decision,
  laterSnooze,
  laterWaiting,
  openAsync,
  openImages,
  ProtocolError,
  type SealedItem,
  type Settled,
  type ShownImage,
  type Snooze,
  sealAsync,
  snoozeStamp,
  type Waiting,
} from "@starbridge/protocol";
import { ApiError, api, lastPage, type Stored } from "../api";
import { type Kept, merge } from "../kept";
import * as store from "../store";
import type { InboxItem, Reply, Decision as ShownDecision } from "../types";
import { type Ctx, expectKind, hold, me, now, openMachine, randomId, refresh } from "./core";

export interface Inbox {
  items: InboxItem[];
  cursor?: string;
  /** Items that failed to open or verify, and why. */
  rejected: { id: string; error: string }[];
  /**
   * Items signed by a member this directory does not hold yet: one paired after the last
   * read. They are tried again on the next load, after the directory is read again.
   */
  retry?: Stored[];
  /** The latest waiting state each machine posted, by `<machine>/<decision id>` (#122). */
  waits?: Record<string, Pick<Waiting, "state" | "at">>;
  /** The owner's latest snooze of each decision, from any device, by decision id (#571). */
  snoozes?: Record<string, Pick<Snooze, "until" | "at">>;
}

/** How each item a settled notice closed was closed, by item id, with the time it closed. */
type Closings = Map<string, { notice: Settled; at: string }>;

async function openDecision(
  ctx: Ctx,
  s: Stored,
  sent: store.SentAnswers,
  closings: Closings = new Map(),
): Promise<InboxItem> {
  const { signer: machine, body } = await openMachine(ctx, s.item, "decision");
  const reply = sent[body.id];
  const closing = closings.get(`${machine.id}/${body.id}`);
  const notice = closing?.notice;
  const answeredBy = notice && wonBy(ctx, notice, body as Decision);
  // Any other notice that closed it arrived in the same write, so it carries the same time; a
  // later one, after a device's answer, closed nothing.
  const settled =
    notice && notice.outcome !== "device" && closing.at === s.answeredAt
      ? notice.outcome
      : undefined;
  // Listed without its blobs (#1382): the images wait, at their size, until they are shown.
  const pending = !!body.images?.length && !s.item.blobs;
  return {
    // Each image opens from its blob, sealed once for every device (#685).
    decision: {
      ...body,
      ...(body.images
        ? {
            images: pending
              ? body.images.map(({ key: _, hash: __, ...image }) => ({ ...image, data: "" }))
              : openImages(s.item, body.images),
          }
        : {}),
    } as ShownDecision,
    ...(pending ? { imagesPending: true as const } : {}),
    machine,
    ...(s.answeredAt ? { answeredAt: s.answeredAt } : {}),
    ...(settled ? { settled } : {}),
    ...(settled === "withdrawn" && notice?.reason ? { reason: notice.reason } : {}),
    ...(answeredBy ? { answeredBy } : {}),
    ...(reply ? { reply: replyOf(reply) } : {}),
  };
}

/**
 * Another device's answer the asking machine took, from its settled notice (#330): undefined for
 * any other notice, or one naming this browser.
 */
function wonBy(ctx: Ctx, notice: Settled, d: Omit<Decision, "images">): InboxItem["answeredBy"] {
  const by = notice.outcome === "device" ? notice.device : undefined;
  if (!by || by === ctx.device.id) return undefined;
  // A device's notice with neither choice nor text applied a Done, on a decision that takes one
  // (#539).
  const reply: Reply | undefined =
    notice.choice !== undefined
      ? { choice: notice.choice }
      : notice.text !== undefined
        ? { text: notice.text }
        : d.answerIn
          ? { done: true }
          : undefined;
  return reply && { device: ctx.dir.members.get(by)?.member.name ?? by, reply };
}

/** The reply alone, without the time a sent answer is stored with. */
function replyOf(r: Reply): Reply {
  if ("choice" in r) return { choice: r.choice };
  if ("text" in r) return { text: r.text };
  return { done: true };
}

/** Opens a decision a push carried (or named, when it did not fit). */
export async function openPushedDecision(ctx: Ctx, item: SealedItem): Promise<InboxItem> {
  const sent = (await store.get("answers", ctx.account)) ?? {};
  const opened = await openDecision(ctx, { item, cursor: "", receivedAt: "" }, sent);
  await hold(ctx);
  return opened;
}

/**
 * Reads decisions after `inbox.cursor` and merges them in: answered ones come back answered.
 * With `keep`, what the server lists is kept sealed in this browser, and a read with no cursor
 * starts from what is kept rather than from the first item (#1380).
 */
/**
 * The sealed decisions the last load kept, by account and id: showing one's images opens them
 * against it without reading the whole kept list again (#2097).
 */
const keptSealed = new Map<string, Stored>();
const sealedKey = (account: string, id: string) => `${account}/${id}`;

/** Forgets what the last loads kept of `account`: on sign-out, revocation, or a reset server. */
export function forgetKeptSealed(account: string) {
  for (const k of keptSealed.keys()) if (k.startsWith(sealedKey(account, ""))) keptSealed.delete(k);
}

/** Holds exactly the kept list's decisions of `account`, so a trimmed one goes too. */
function holdKeptSealed(account: string, items: Stored[]) {
  forgetKeptSealed(account);
  for (const s of items)
    if (s.item.kind === "decision") keptSealed.set(sealedKey(account, s.item.id), s);
}

export async function loadInbox(
  ctx: Ctx,
  inbox: Inbox = { items: [], rejected: [] },
  opts: {
    keep?: boolean;
    /**
     * Given the kept questions the server lists open, once they are opened and before the
     * answered ones: a load shows what needs the owner first (#1458).
     */
    early?: (inbox: Inbox) => void;
  } = {},
): Promise<Inbox> {
  // The kept items, and the decisions the server holds open now: those settle which kept
  // questions it dropped, and whether what is kept still matches the server at all.
  let kept: Kept | undefined;
  let open: Set<string> | undefined;
  if (opts.keep && inbox.cursor === undefined) {
    const had = await store.get("kept", ctx.account);
    if (had?.device === ctx.device.id) {
      open = new Set();
      let at: string | undefined;
      for (;;) {
        // Only the ids count: the kept copies hold the questions and their images (#2097). A
        // server from before blobs=none refuses it, and lists them with their images instead.
        const page = await api.items("decision", at, { open: true, noBlobs: true }).catch((e) => {
          if (e instanceof ApiError && e.status === 400 && e.code === "bad-request")
            return api.items("decision", at, { open: true });
          throw e;
        });
        for (const s of page.items) open.add(s.item.id);
        at = page.cursor;
        if (lastPage(page)) break;
      }
      // The open questions show with their images; an answered one's open when it is shown.
      const blobs = await store.keptBlobs(
        ctx.account,
        had.items
          .filter((k) => k.item.kind === "decision" && !k.answeredAt && !k.item.blobs)
          .map((k) => k.item.id),
      );
      kept = {
        ...had,
        items: had.items.map((k) => {
          const b = k.item.kind === "decision" ? blobs.get(k.item.id) : undefined;
          return b ? { ...k, item: { ...k.item, blobs: b } } : k;
        }),
      };
    }
  }
  const sent = (await store.get("answers", ctx.account)) ?? {};
  // Decisions opened before a machine was revoked no longer verify: drop them.
  const byId = new Map(
    inbox.items
      .filter((i) => ctx.dir.members.get(i.machine.id)?.active)
      .map((i) => [i.decision.id, i]),
  );
  const rejected = [...inbox.rejected];
  const retry: Stored[] = [];
  // A settled notice lists before the decision it closed, which moved past it.
  const closings: Closings = new Map();
  const waits = { ...inbox.waits };
  const snoozes = { ...inbox.snoozes };
  const take = async (s: Stored, again: boolean) => {
    if (s.item.kind === "snooze") {
      // Only tells until when the owner put a decision off: one that fails costs that alone.
      try {
        const z = await openSnooze(ctx, s.item);
        if (laterSnooze(snoozes[z.decisionId], z))
          snoozes[z.decisionId] = { until: z.until, at: z.at };
      } catch {}
      return;
    }
    if (s.item.kind === "waiting") {
      // Only tells whether the agent waits: one that fails to open costs that and nothing else.
      try {
        const { signer, body } = await openMachine(ctx, s.item, "waiting");
        const w = body as Waiting;
        const key = `${signer.id}/${w.decisionId}`;
        if (laterWaiting(waits[key], w)) waits[key] = { state: w.state, at: w.at };
      } catch {}
      return;
    }
    if (s.item.kind === "settled") {
      // Only tells how a decision closed: one that fails to open costs that and nothing else.
      try {
        const { signer, body } = await openMachine(ctx, s.item, "settled");
        // Keyed by machine: a notice closes only the machine's own items (#362).
        closings.set(`${signer.id}/${body.itemId}`, { notice: body, at: s.receivedAt });
      } catch {}
      return;
    }
    try {
      const item = await openDecision(ctx, s, sent, closings);
      byId.set(item.decision.id, item);
    } catch (e) {
      // A revoked machine's old decisions no longer verify; nothing to show or warn about.
      if (e instanceof ProtocolError && e.code === "revoked-signer") return;
      if (e instanceof ProtocolError && e.code === "unknown-signer" && !again) {
        retry.push(s);
        return;
      }
      if (!rejected.some((r) => r.id === s.item.id))
        rejected.push({ id: s.item.id, error: e instanceof Error ? e.message : String(e) });
    }
  };
  // Only the machine that asked can say its agent waits on the question.
  const shown = () =>
    [...byId.values()].map((i) => {
      const w = waits[`${i.machine.id}/${i.decision.id}`];
      const z = snoozes[i.decision.id];
      const { waitingSince: _, snoozedUntil: __, ...rest } = i;
      return {
        ...rest,
        ...(w?.state === "waiting" ? { waitingSince: w.at } : {}),
        // Back now ends at its own time, read before this browser's clock, which may run behind.
        ...(z && Date.parse(z.until) > Date.parse(z.at) ? { snoozedUntil: z.until } : {}),
      };
    });
  // What tells an open question's state first, then the questions, then the answered ones.
  const first = (s: Stored) =>
    s.item.kind === "waiting" ||
    s.item.kind === "snooze" ||
    (s.item.kind === "decision" && !s.answeredAt && !!open?.has(s.item.id));
  const keptItems = kept?.items ?? [];
  if (opts.early && open && open.size > 0) {
    for (const s of keptItems) if (first(s)) await take(s, false);
    if (byId.size > 0) {
      // Never past a hold: while the server withholds entries, no machine's item shows (#362).
      await hold(ctx);
      opts.early({
        items: shown(),
        rejected: [...rejected],
        waits: { ...waits },
        snoozes: { ...snoozes },
      });
    }
    for (const s of keptItems) if (!first(s)) await take(s, false);
  } else for (const s of keptItems) await take(s, false);
  for (const s of inbox.retry ?? []) await take(s, true);
  let cursor = inbox.cursor ?? kept?.cursor;
  const read: Stored[] = [];
  for (;;) {
    const page = await api.items("decision,settled,waiting,snooze", cursor, {
      openBlobs: opts.keep,
    });
    for (const s of page.items) await take(s, false);
    if (opts.keep) read.push(...page.items);
    cursor = page.cursor;
    if (lastPage(page)) break;
  }
  const drop = new Set<string>();
  if (kept && open) {
    const listed = new Set(read.filter((s) => s.item.kind === "decision").map((s) => s.item.id));
    const held = new Set(
      kept.items.filter((s) => s.item.kind === "decision").map((s) => s.item.id),
    );
    // An open question neither kept nor listed after the cursor: the server is not the one
    // these were kept from (restored, or reset). Read it all again.
    if ([...open].some((id) => !held.has(id) && !listed.has(id))) {
      await store.del("kept", ctx.account);
      forgetKeptSealed(ctx.account);
      return loadInbox(ctx, inbox, opts);
    }
    // Kept open, not open on the server and not listed since, so not answered either: the
    // server dropped it (PROTOCOL.md, Limits). One listed since came after the open list.
    for (const s of kept.items)
      if (
        s.item.kind === "decision" &&
        !s.answeredAt &&
        !open.has(s.item.id) &&
        !listed.has(s.item.id)
      ) {
        drop.add(s.item.id);
        byId.delete(s.item.id);
      }
  }
  // The machine names the winner after the answer, so its notice often lists without the
  // decision, which an earlier read already holds.
  for (const [key, { notice }] of closings) {
    const item = byId.get(notice.itemId);
    const answeredBy = item && wonBy(ctx, notice, item.decision);
    if (item && answeredBy && !item.reply && key === `${item.machine.id}/${notice.itemId}`)
      byId.set(notice.itemId, { ...item, answeredBy });
  }
  const items = shown();
  await noteSnoozes(
    ctx,
    Object.entries(snoozes).map(([decisionId, z]) => ({ decisionId, at: z.at, until: z.until })),
  );
  await hold(ctx);
  if (opts.keep && kept) holdKeptSealed(ctx.account, kept.items);
  if (opts.keep && (read.length > 0 || drop.size > 0) && cursor !== undefined) {
    const at = cursor;
    let items: Stored[] = [];
    await store.update("kept", ctx.account, (had) => {
      items = merge(had?.device === ctx.device.id ? had.items : [], read, drop);
      return { device: ctx.device.id, cursor: at, items };
    });
    holdKeptSealed(ctx.account, items);
  }
  return { items, cursor, rejected, retry, waits, snoozes } satisfies Inbox;
}

/**
 * The images of a decision listed without them (#1382), fetched with the item and checked
 * against the hashes its signed body holds; kept with the item, so they download once.
 */
export async function loadImages(ctx: Ctx, id: string): Promise<ShownImage[]> {
  // Each blob opens against the body this browser kept, from the same machine: never refs the
  // server sends now under that id (#1472).
  const kept =
    keptSealed.get(sealedKey(ctx.account, id)) ??
    (await store.get("kept", ctx.account))?.items.find(
      (k) => k.item.kind === "decision" && k.item.id === id,
    );
  if (!kept) throw new Error("this question is not kept here");
  const was = await openMachine(ctx, kept.item, "decision");
  const local = kept.item.blobs ?? (await store.keptBlobs(ctx.account, [id])).get(id);
  if (local) return openImages({ ...kept.item, blobs: local }, (was.body as Decision).images);
  const s = await api.item(id);
  const { signer, body } = await openMachine(ctx, s.item, "decision");
  if (body.id !== id || signer.id !== was.signer.id)
    throw new Error("the server sent another question");
  const images = openImages(s.item, (was.body as Decision).images);
  const blobs = s.item.blobs;
  // Kept while this device keeps the question, read again when the images are written.
  if (blobs) await store.keepBlobs(ctx.account, ctx.device.id, id, blobs);
  return images;
}

/** Signs the answer and seals it to the machine that asked, which must still be active. */
export async function answer(ctx: Ctx, item: InboxItem, reply: Reply): Promise<string> {
  const fresh = await refresh(ctx);
  await hold(fresh);
  const machine = fresh.dir.members.get(item.machine.id);
  if (!machine?.active) throw new Error(`${item.machine.name} was revoked`);
  const answeredAt = now();
  const sealed = await sealAsync(
    "answer",
    {
      v: 1,
      id: randomId("a_"),
      decisionId: item.decision.id,
      to: machine.member.id,
      answeredAt,
      ...reply,
      // Lets the machine notice a server holding back entries, such as a revocation.
      dir: { length: fresh.dir.length, head: fresh.dir.head },
    },
    me(fresh),
    [machine.member],
  );
  await api.post(sealed);
  // The page and the service worker may both answer: merge into the record, never overwrite it.
  await store.update("answers", ctx.account, (sent) => ({
    ...sent,
    [item.decision.id]: { ...reply, answeredAt },
  }));
  return answeredAt;
}

/**
 * The latest snooze kept of `id` in the `snoozes` record. Its `until` is kept beside it, for the
 * time it was written with; a time a page from before #2103 wrote has none, and reads as the
 * latest possible, so the same snooze, pushed again at its time, wins the tie and is noted whole.
 */
export function keptSnooze(
  record: Record<string, string> | undefined,
  id: string,
): { at: string; until: string } | undefined {
  const at = record?.[id];
  if (!at) return undefined;
  const [tieAt, until] = (record?.[`until:${id}`] ?? "").split(" ");
  return { at, until: tieAt === at && until ? until : "9999-12-31T23:59:59.999Z" };
}

/**
 * Keeps the latest snooze this browser knows per decision, for the service worker (#571) and
 * the next snooze's time. Returns whether each given is the latest, or the same as it.
 */
export async function noteSnoozes(
  ctx: Pick<Ctx, "account">,
  seen: { decisionId: string; at: string; until: string }[],
): Promise<boolean> {
  let newest = true;
  await store.update("snoozes", ctx.account, (old) => {
    const next = { ...old };
    for (const z of seen) {
      const had = keptSnooze(next, z.decisionId);
      if (laterSnooze(had, z)) {
        // The time stays where pages from before #2103 read and compare it.
        next[z.decisionId] = z.at;
        next[`until:${z.decisionId}`] = `${z.at} ${z.until}`;
      } else if (had && laterSnooze(z, had)) newest = false;
    }
    return next;
  });
  return newest;
}

/** Opens a snooze another device, or this one, sealed to this browser (#571). */
export async function openSnooze(ctx: Ctx, item: SealedItem): Promise<Snooze> {
  const { body } = await openAsync(expectKind(item, "snooze"), me(ctx), ctx.dir);
  return body as Snooze;
}

/**
 * Puts the question off until `until` (#571), or brings it back with a time already passed:
 * sealed to the machine that asked, so its agent hears of it when it would block, and to every
 * active device, this one included, so each one hides it.
 */
export async function snooze(ctx: Ctx, item: InboxItem, until: string): Promise<Snooze> {
  const fresh = await refresh(ctx);
  await hold(fresh);
  const machine = fresh.dir.members.get(item.machine.id);
  if (!machine?.active) throw new Error(`${item.machine.name} was revoked`);
  const to = [machine.member, ...activeMembers(fresh.dir, "device")];
  // Past the latest snooze of it this browser knows, read after the directory's await: one a
  // phone stamped a second ahead, or from a clock that runs ahead, would win over it (#2103).
  const last = keptSnooze(await store.get("snoozes", ctx.account), item.decision.id);
  const body: Snooze = {
    v: 1,
    id: randomId("z_"),
    decisionId: item.decision.id,
    to: to.map((m) => m.id),
    until,
    at: snoozeStamp(Date.now(), last?.at),
    dir: { length: fresh.dir.length, head: fresh.dir.head },
  };
  await api.post(await sealAsync("snooze", body, me(fresh), to));
  await noteSnoozes(ctx, [body]);
  return body;
}

/** Opens a waiting notice, with the machine that signed it. */
export async function openWaiting(ctx: Ctx, item: SealedItem) {
  const { signer, body } = await openMachine(ctx, item, "waiting");
  return { machine: signer.id, waiting: body as Waiting };
}
