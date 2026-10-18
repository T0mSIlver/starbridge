// What every item kind needs from the device (lib/device.ts): the verified chain, this device's
// keys, and the hold that keeps machines' items back while the server withholds entries (#362).
// The device drives the session, pairing and recovery on the same.
import {
  addEntryAsync,
  type Directory,
  type DirectoryHead,
  entryHash,
  forgetHeads,
  fromB64,
  type Held,
  type Member,
  noteHead,
  openAsync,
  ProtocolError,
  type SealedItem,
  type SignedEnvelope,
  toB64,
  verifyDirectory,
  withheldBy,
} from "@starbridge/protocol";
import { ApiError, api } from "../api";
import { sealOpener, signer } from "../crypto/keys";
import * as store from "../store";

/** A device of a verified directory, signed in and bound to this browser's keys. */
export interface Ctx {
  account: string;
  device: store.DeviceRecord;
  dir: Directory;
  entries: SignedEnvelope[];
}

export const now = () => new Date().toISOString();

export function randomId(prefix: string): string {
  return prefix + toB64(crypto.getRandomValues(new Uint8Array(12)));
}

/** Moves the pin to a verified chain; refuses one that does not extend the stored pin. */
export function pinTo(account: string, entries: SignedEnvelope[], dir: Directory): Promise<void> {
  return store.extendPin(account, { length: dir.length, head: dir.head }, (n) => {
    const e = entries[n - 1];
    return e ? entryHash(e.body) : undefined;
  });
}

/** A browser with no pin was served a chain that nothing it holds anchors. */
export class Unanchored extends Error {}

/**
 * Fetches the chain, replays it against the pin, and moves the pin forward. Without a pin, only
 * a genesis this browser's device signed anchors the chain (a first device cut off before it
 * pinned): any other the server could have made, listing keys it relayed (#354).
 */
export async function trusted(
  account: string,
  read?: SignedEnvelope[],
): Promise<{ dir: Directory; entries: SignedEnvelope[] }> {
  for (let attempt = 0; ; attempt++) {
    const entries = (attempt === 0 && read) || (await api.directory());
    const pin = await store.get("pin", account);
    if (!pin && !signedGenesis(account, entries[0], await store.get("device", account)))
      throw new Unanchored("no pin anchors this directory");
    const dir = verifyDirectory(entries, { account, ...(pin ? { pin } : {}) });
    // A chain that drops this browser while a machine's head shows it cut short holds, and is not
    // pinned: the full chain need not extend it (#1779).
    const mine = await store.get("device", account);
    const entry = mine && dir.members.get(mine.id);
    if (entry && !entry.active && (await heldRemoval(account, { dir, entries })))
      return { dir, entries };
    try {
      await pinTo(account, entries, dir);
      return { dir, entries };
    } catch (e) {
      // The service worker or another tab pinned a longer chain meanwhile: read it again.
      if (e instanceof store.StalePin && attempt < 2) continue;
      throw e;
    }
  }
}

/** Whether `entry`, once verified as entry 0, is a genesis this browser's own device signed. */
function signedGenesis(
  account: string,
  entry: SignedEnvelope | undefined,
  device?: store.DeviceRecord,
): boolean {
  if (!device || entry?.signer !== device.id) return false;
  try {
    return (
      verifyDirectory([entry], { account }).members.get(device.id)?.member.signPk === device.signPk
    );
  } catch {
    return false;
  }
}

/** A head a machine signed that the chain dropping this browser lacks (#1779). */
export async function heldRemoval(
  account: string,
  chain: { dir: Directory; entries: SignedEnvelope[] },
): Promise<Held | undefined> {
  return withheldBy((await store.get("heads", account)) ?? {}, chain.dir, chain.entries);
}

export async function refresh(ctx: Ctx): Promise<Ctx> {
  return { ...ctx, ...(await trusted(ctx.account)) };
}

export const me = (ctx: Ctx) => ({
  id: ctx.device.id,
  sign: signer(ctx.device.keys),
  openSeal: sealOpener(ctx.device.keys, fromB64(ctx.device.boxPk)),
});

/** Appends an entry this device signed, after checking locally that the chain accepts it. */
export async function append(
  ctx: Ctx,
  make: (dir: Directory) => Promise<SignedEnvelope>,
): Promise<Ctx> {
  let fresh = await refresh(ctx);
  for (let attempt = 0; ; attempt++) {
    const entry = await make(fresh.dir);
    const dir = verifyDirectory([...fresh.entries, entry], { account: ctx.account });
    try {
      await api.append(entry);
    } catch (e) {
      // Another device appended first: replay and sign again on top of it.
      if (e instanceof ApiError && e.code === "not-next" && attempt < 2) {
        fresh = await refresh(fresh);
        continue;
      }
      throw e;
    }
    const entries = [...fresh.entries, entry];
    try {
      await pinTo(ctx.account, entries, dir);
    } catch (e) {
      // The entry is on the server and a longer chain was pinned meanwhile: carry on from it,
      // so the caller (an approval) still finishes.
      if (e instanceof store.StalePin) return refresh(fresh);
      throw e;
    }
    return { ...fresh, dir, entries };
  }
}

/**
 * Adds a member to approve, unless the directory already holds it with these keys: an approval
 * retried after its post failed reuses the entry the first try appended.
 */
export async function appendMember(ctx: Ctx, member: Member): Promise<Ctx> {
  const fresh = await refresh(ctx);
  const held = fresh.dir.members.get(member.id);
  if (
    held?.active &&
    held.member.role === member.role &&
    held.member.boxPk === member.boxPk &&
    held.member.signPk === member.signPk
  )
    return fresh;
  return append(fresh, (dir) => addEntryAsync(dir, me(fresh), member, now()));
}

/**
 * Reads the directory again and checks this device is still in it; undefined once revoked. Run
 * before each load, so items from members paired elsewhere since boot verify.
 */
export async function reverify(ctx: Ctx): Promise<Ctx | undefined> {
  const fresh = await refresh(ctx);
  const self = fresh.dir.members.get(ctx.device.id);
  return self?.active ? fresh : undefined;
}

/** The server picks what it lists: an item of another kind is refused before it is opened. */
export function expectKind<K extends SealedItem["kind"]>(item: SealedItem, kind: K) {
  if (item.kind !== kind)
    throw new ProtocolError("wrong-kind", `${item.kind} where ${kind} was due`);
  return item as SealedItem & { kind: K };
}

/**
 * Opens a machine's item and keeps the directory head it signed, the longest per machine.
 */
export async function openMachine<K extends SealedItem["kind"]>(
  ctx: Ctx,
  item: SealedItem,
  kind: K,
): ReturnType<typeof openAsync<K>> {
  const opened = await openAsync(expectKind(item, kind), me(ctx), ctx.dir);
  const head = (opened.body as { dir?: DirectoryHead }).dir;
  // Read with the heads: a read that began before the owner stopped waiting must not bring back
  // a head they told this browser to forget (#813).
  if (head)
    await store.updateWith("heads", ctx.account, "forgotten", (old, forgotten = []) => {
      const heads = { ...old };
      if (!forgotten.includes(opened.signer.id))
        noteHead(heads, opened.signer.id, head, ctx.entries);
      return heads;
    });
  return opened;
}

/**
 * Throws `Withheld` while a head a machine active in this browser's chain signed is missing
 * from it. Loaders call it once they kept the heads of what they opened, so the item that shows
 * the gap holds back the others it came with. It reads the directory once more first: a machine
 * may only have signed an entry made on another device since this page read it.
 */
export async function hold(ctx: Ctx): Promise<void> {
  const heads = (await store.get("heads", ctx.account)) ?? {};
  if (!withheldBy(heads, ctx.dir, ctx.entries)) return;
  const fresh = await refresh(ctx);
  // Read again: the owner may have stopped waiting while the directory loaded.
  const now = (await store.get("heads", ctx.account)) ?? {};
  const held = withheldBy(now, fresh.dir, fresh.entries);
  if (held) throw new Withheld(heldText(fresh.dir, held), held.revoked?.id);
}

/**
 * Names the machine whose head shows the gap. A head whose member a `revoke` entry names says who
 * revoked it, since the owner alone can tell whether they did or a revoked device forged it on a
 * fork (#813).
 */
export function heldText(dir: Directory, held: Held): string {
  const name = (id: string) => dir.members.get(id)?.member.name ?? id;
  const machine = name(held.id);
  const seen = `The server is holding back changes to your devices that ${machine} has seen.`;
  if (held.revoked) {
    const { id, by, at } = held.revoked;
    return `${seen} ${name(by)} revoked ${name(id)} on ${at.slice(0, 10)}. If you did not, the server may be hiding that ${name(by)} was revoked. Nothing from your machines shows until this clears.`;
  }
  return `${seen} Nothing from your machines shows until it sends them. If this does not clear, revoke ${machine}.`;
}

/**
 * The server holds back directory entries a machine has seen: no machine's item counts (#362).
 * `revoked`: the member a `revoke` entry names, whose heads the owner can tell this browser to
 * forget once they say they made that revocation (#813).
 */
export class Withheld extends Error {
  constructor(
    message: string,
    readonly revoked?: string,
  ) {
    super(message);
  }
}

/**
 * Forgets the directory heads member `id` signed, on the owner's word that they
 * revoked it, and keeps none of them again: no revocation ends a hold by itself, since a revoked
 * device can forge one on a fork (#813). Ids are never reused, so the list only grows by the
 * members the owner revokes.
 */
export async function stopWaiting(ctx: Pick<Ctx, "account">, id: string): Promise<void> {
  // First, so a read noting heads meanwhile either sees it or has its head deleted below.
  await store.update("forgotten", ctx.account, (old = []) =>
    old.includes(id) ? old : [...old, id],
  );
  await store.update("heads", ctx.account, (old) => {
    const heads = { ...old };
    forgetHeads(heads, id);
    return heads;
  });
}
