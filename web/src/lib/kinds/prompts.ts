// Permission prompts: a machine's agent asks to run a tool, and this device allows or denies it.
// Settled notices say how each ended; the inbox reads the ones that close decisions itself.
import {
  type Permission,
  type SealedItem,
  type Settled,
  sealAsync,
  visible,
} from "@starbridge/protocol";
import { api, lastPage, type Stored } from "../api";
import * as store from "../store";
import type { PromptItem, PromptReply } from "../types";
import { type Ctx, hold, me, now, openMachine, randomId, refresh } from "./core";

async function openPermission(
  ctx: Ctx,
  s: Stored,
  sent: Record<string, PromptReply & { answeredAt: string }>,
): Promise<PromptItem> {
  const { signer: machine, body } = await openMachine(ctx, s.item, "permission");
  const reply = sent[body.id];
  const p = body as Permission;
  return {
    // What the owner reads shows bidi and invisible characters as escapes (#357).
    permission: {
      ...p,
      summary: visible(p.summary),
      ...(p.description !== undefined ? { description: visible(p.description) } : {}),
      suggestions: p.suggestions.map((g) => ({ ...g, rule: visible(g.rule) })),
    },
    machine,
    receivedAt: s.receivedAt,
    ...(s.answeredAt ? { answeredAt: s.answeredAt } : {}),
    ...(reply ? { reply: stripTime(reply) } : {}),
  };
}

const stripTime = ({ answeredAt: _, ...reply }: PromptReply & { answeredAt: string }) =>
  reply as PromptReply;

/** Opens a permission prompt a push carried (or named). */
export async function openPushedPermission(ctx: Ctx, item: SealedItem): Promise<PromptItem> {
  const sent = (await store.get("promptAnswers", ctx.account)) ?? {};
  const opened = await openPermission(ctx, { item, cursor: "", receivedAt: "" }, sent);
  await hold(ctx);
  return opened;
}

/** Opens a settled notice, with the machine that signed it. */
export async function openSettled(ctx: Ctx, item: SealedItem) {
  const { signer, body } = await openMachine(ctx, item, "settled");
  return { machine: signer.id, settled: body as Settled };
}

/**
 * Settled notices after `cursor`, keyed by "machine/permission id". Without one, the read starts
 * at the kept inbox's cursor (#1380) rather than at the first notice the server holds: a notice
 * before it closed a prompt the server no longer lists open, which the page never shows (#1455).
 */
export async function loadSettled(ctx: Ctx, cursor?: string) {
  const out = new Map<string, Settled>();
  let at = cursor;
  if (at === undefined) {
    const kept = await store.get("kept", ctx.account);
    // A prompt open now that lists at or before that cursor: a reset or restored server, whose
    // notices may sit below it too, or one open since before the kept read. Read them all.
    const open =
      kept?.device === ctx.device.id &&
      (await api.items("permission", undefined, { open: true })).items;
    if (open && !open.some((s) => Number(s.cursor) <= Number(kept.cursor))) at = kept.cursor;
  }
  for (;;) {
    const page = await api.items("settled", at);
    for (const s of page.items) {
      try {
        const { machine, settled } = await openSettled(ctx, s.item);
        out.set(`${machine}/${settled.itemId}`, settled);
      } catch {}
    }
    at = page.cursor;
    if (lastPage(page)) {
      await hold(ctx);
      return { settled: out, cursor: at };
    }
  }
}

/** Reads every page of `kinds` from the start, opening what verifies. */
async function readAll<T>(
  kinds: string,
  opts: { open?: boolean },
  take: (s: Stored) => Promise<T>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await api.items(kinds, cursor, opts);
    for (const s of page.items) {
      try {
        out.push(await take(s));
      } catch {
        // A prompt that fails to verify is never shown: it could ask to allow anything.
      }
    }
    cursor = page.cursor;
    if (lastPage(page)) return out;
  }
}

/** The prompts waiting now, whose answer window is still open. */
export async function loadPrompts(ctx: Ctx): Promise<PromptItem[]> {
  const sent = (await store.get("promptAnswers", ctx.account)) ?? {};
  const open = await readAll("permission", { open: true }, (s) => openPermission(ctx, s, sent));
  await hold(ctx);
  return open;
}

/** The last 7 days of prompts, with how each ended (the server keeps a week). */
export async function loadPromptLog(ctx: Ctx): Promise<PromptItem[]> {
  const sent = (await store.get("promptAnswers", ctx.account)) ?? {};
  const permissions = await readAll("permission", {}, (s) => openPermission(ctx, s, sent));
  const settled = await readAll("settled", {}, (s) => openMachine(ctx, s.item, "settled"));
  // A notice counts only from the machine that asked.
  const byId = new Map(settled.map((x) => [`${x.signer.id}/${x.body.itemId}`, x.body]));
  await hold(ctx);
  return permissions.map((p) => {
    const st = byId.get(`${p.machine.id}/${p.permission.id}`);
    return st ? { ...p, settled: st as Settled } : p;
  });
}

/**
 * Signs the answer, bound to the prompt's id and input hash, and seals it to the machine that
 * asked, which must still be active.
 */
export async function answerPermission(
  ctx: Ctx,
  item: PromptItem,
  reply: PromptReply,
): Promise<string> {
  const fresh = await refresh(ctx);
  await hold(fresh);
  const machine = fresh.dir.members.get(item.machine.id);
  if (!machine?.active) throw new Error(`${item.machine.name} was revoked`);
  const answeredAt = now();
  const sealed = await sealAsync(
    "permission-answer",
    {
      v: 1,
      id: randomId("pa_"),
      permissionId: item.permission.id,
      to: machine.member.id,
      answeredAt,
      inputHash: item.permission.inputHash,
      ...reply,
      // Lets the machine notice a server holding back entries, such as a revocation.
      dir: { length: fresh.dir.length, head: fresh.dir.head },
    },
    me(fresh),
    [machine.member],
  );
  await api.post(sealed);
  await store.update("promptAnswers", ctx.account, (sent) => ({
    ...sent,
    [item.permission.id]: { ...reply, answeredAt },
  }));
  return answeredAt;
}
