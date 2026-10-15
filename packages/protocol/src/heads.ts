// Detecting a withheld directory entry from the heads other members sign (PROTOCOL.md
// "Directory"). Devices sign theirs into answers and machines into every item, so each side can
// tell when the server serves it a shorter chain than a member it hears from has seen.
import { type Directory, holdsHead } from "./directory";
import { type DirectoryHead, SignedEnvelope } from "./schemas";

/**
 * The longest head each signer vouched for, keyed by the signer. Heads kept before #1627 may also
 * sit under "signer/by" or "signer/?", where machines before #794 put a device's head they passed
 * on: each counts as a head its signer vouched for, since only the signer signed it, and goes
 * when either the signer's or the by's heads are forgotten (#1730).
 */
export type Heads = Record<string, DirectoryHead>;

/** The member that signed a kept head: its key, up to the "/" of a key kept before #1627. */
function signerOf(key: string): string {
  return key.split("/")[0] as string;
}

/** The device whose head a machine before #794 passed on: a key kept before #1627, after its "/". */
function byOf(key: string): string | undefined {
  return key.split("/")[1];
}

/** The `revoke` entry of `entries` that names `id`: who signed it, and when. */
export interface Revocation {
  id: string;
  by: string;
  at: string;
}

/** The `revoke` entry that names member `id`, if any; a `recover` names no one. */
export function revocationOf(entries: unknown[], id: string): Revocation | undefined {
  for (const raw of entries) {
    const env = SignedEnvelope.safeParse(raw);
    if (!env.success) continue;
    const body = JSON.parse(env.data.body) as { op?: string; id?: string; at?: string };
    if (body.op === "revoke" && body.id === id)
      return { id, by: env.data.signer, at: body.at ?? "" };
  }
  return undefined;
}

/**
 * Whether a head that member `id` signed no longer counts: the chain lists `id` as revoked, and a
 * `recover` came after any `revoke` that names it. A member signs no head past its own
 * revocation, so a chain whose `revoke` comes before a head that member signed forks from the one
 * it saw; a `revoke` therefore ends nothing (#813). A `recover`, which only the recovery key
 * signs, revokes every member and starts over: it ends every earlier hold.
 */
function removed(dir: Directory, entries: unknown[], id: string): boolean {
  if (dir.members.get(id)?.active !== false) return false;
  let revokedAt = -1;
  let recoveredAt = -1;
  entries.forEach((raw, i) => {
    const env = SignedEnvelope.safeParse(raw);
    if (!env.success) return;
    const body = JSON.parse(env.data.body) as { op?: string; id?: string };
    if (body.op === "revoke" && body.id === id) revokedAt = i;
    if (body.op === "recover") recoveredAt = i;
  });
  return recoveredAt > revokedAt;
}

/**
 * Records the head `signer` signed into an item. A shorter head never replaces a longer one the
 * chain `entries` lacks, so replaying an older item cannot lift a hold. A head that names a `by`,
 * which a machine before #794 passed on from a device, is not kept: it may lie on that device's
 * fork, and in the signer's slot it could push out the signer's own head that shows a gap (#1627).
 * True when it changed.
 */
export function noteHead(
  heads: Heads,
  signer: string,
  head: DirectoryHead | undefined,
  entries: unknown[],
): boolean {
  if (!head || head.by !== undefined) return false;
  const known = heads[signer];
  const replace =
    !known ||
    head.length > known.length ||
    (holdsHead(entries, known) && !holdsHead(entries, head));
  if (replace) heads[signer] = { length: head.length, head: head.head };
  return replace;
}

/** A kept head the chain lacks, who signed it, and the `revoke` that names its signer. */
export interface Held {
  id: string;
  head: DirectoryHead;
  revoked?: Revocation;
}

/**
 * A kept head the chain `entries` lacks: the server is holding back entries it has, or serving
 * the member that signed it another chain. It counts while its signer is listed in `dir` and no
 * `recover` removed it. A `revoke` does not end it (#813): a revoked device whose revocation the
 * server hides can extend a stale chain and revoke the member whose head exposes it. Such a head
 * says so in `revoked`; a head without one is returned first. Undefined while none counts.
 */
export function withheldBy(heads: Heads, dir: Directory, entries: unknown[]): Held | undefined {
  let fork: Held | undefined;
  for (const [key, kept] of Object.entries(heads)) {
    const id = signerOf(key);
    if (!dir.members.has(id) || removed(dir, entries, id)) continue;
    if (holdsHead(entries, kept)) continue;
    const head = { length: kept.length, head: kept.head };
    const revoked = dir.members.get(id)?.active ? undefined : revocationOf(entries, id);
    if (!revoked) return { id, head };
    fork ??= { id, head, revoked };
  }
  return fork;
}

/**
 * Drops every kept head member `id` signed, and every head kept before #1627 that a machine
 * passed on from `id` (#1730): the owner's way out after revoking a member that signed a false
 * long head, which no revocation ends. A device does it on its own when it signs that revocation,
 * and on the owner's word otherwise. True when any went.
 */
export function forgetHeads(heads: Heads, id: string): boolean {
  let changed = false;
  for (const key of Object.keys(heads))
    if (signerOf(key) === id || byOf(key) === id) {
      delete heads[key];
      changed = true;
    }
  return changed;
}
