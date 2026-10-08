// Detecting a withheld directory entry from the heads other members sign (PROTOCOL.md
// "Directory"). Devices sign theirs into answers and machines into every item, so each side can
// tell when the server serves it a shorter chain than a member it hears from has seen.
import { type Directory, holdsHead } from "./directory";
import { type DirectoryHead, SignedEnvelope } from "./schemas";

/**
 * The longest head each signer vouched for, keyed by the signer, by "signer/by" for a head it
 * passed on from member `by`, or by "signer/?" for one passed on from a member this chain does
 * not list yet: one such slot per signer, so storage stays bounded.
 */
export type Heads = Record<string, DirectoryHead>;

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
 * Whether a head that member `id` signed, or that names it as `by`, no longer counts: the chain
 * lists `id` as revoked and no `revoke` entry names it, so the recovery key's `recover` removed
 * it. A member signs no head past its own revocation, so a chain whose `revoke` comes before a
 * head that member signed forks from the one it saw; a `revoke` therefore ends nothing (#813).
 */
function removed(dir: Directory, entries: unknown[], id: string): boolean {
  return dir.members.get(id)?.active === false && !revocationOf(entries, id);
}

/**
 * Records the head `signer` signed into an item. A shorter head never replaces a longer one the
 * chain `entries` lacks, so replaying an older item cannot lift a hold. With `dir`, a `by` that
 * chain does not list goes in the signer's one unknown slot, and a head passed on from a `by` it
 * lists as revoked is not kept: once the owner forgot that member's heads (`forgetHeads`), the
 * item that carried one, read again, must not bring it back. A fork served before the head could
 * revoke its signer as well, whose items then open no more, so this gives a server nothing new.
 * True when it changed.
 */
export function noteHead(
  heads: Heads,
  signer: string,
  head: DirectoryHead | undefined,
  entries: unknown[],
  dir?: Directory,
): boolean {
  if (!head) return false;
  const by = head.by && head.by !== signer ? head.by : undefined;
  if (by && dir?.members.get(by)?.active === false) return false;
  const key = !by ? signer : dir && !dir.members.has(by) ? `${signer}/?` : `${signer}/${by}`;
  const known = heads[key];
  // A head passed on from a member a `recover` removed counts no more: any head replaces it, or
  // a forged long one would keep a real shorter one out of its slot for good.
  const dropped = !!known?.by && !!dir && removed(dir, entries, known.by);
  const replace =
    !known ||
    dropped ||
    head.length > known.length ||
    (holdsHead(entries, known) && !holdsHead(entries, head));
  if (replace) heads[key] = head;
  return replace;
}

/** A kept head the chain lacks, who signed it, and the `revoke` that names a member it hangs on. */
export interface Held {
  id: string;
  by?: string;
  head: DirectoryHead;
  revoked?: Revocation;
}

/**
 * A kept head the chain `entries` lacks: the server is holding back entries it has, or serving
 * the member that signed it another chain. It counts while its signer is listed in `dir` and
 * neither it nor its `by` was removed by a `recover`. A `by` the chain does not list counts, since
 * its `add` may be what the server holds back. A `revoke` of either does not end it (#813): a
 * revoked device whose revocation the server hides can extend a stale chain and revoke the member
 * whose head exposes it. Such a head says so in `revoked`; a head without one is returned first.
 * Undefined while none counts.
 */
export function withheldBy(heads: Heads, dir: Directory, entries: unknown[]): Held | undefined {
  let fork: Held | undefined;
  for (const [key, head] of Object.entries(heads)) {
    const id = key.split("/")[0] as string;
    const by = head.by && head.by !== id ? head.by : undefined;
    if (!dir.members.has(id) || removed(dir, entries, id)) continue;
    if (by && removed(dir, entries, by)) continue;
    if (holdsHead(entries, head)) continue;
    const revoked =
      (dir.members.get(id)?.active ? undefined : revocationOf(entries, id)) ??
      (by && dir.members.get(by)?.active === false ? revocationOf(entries, by) : undefined);
    if (!revoked) return { id, ...(by ? { by } : {}), head };
    fork ??= { id, ...(by ? { by } : {}), head, revoked };
  }
  return fork;
}

/**
 * Drops every kept head member `id` signed or that names it as `by`: the owner's way out after
 * revoking a member that signed a false long head, which no revocation ends. A device does it on
 * its own when it signs that revocation, and on the owner's word otherwise. True when any went.
 */
export function forgetHeads(heads: Heads, id: string): boolean {
  let changed = false;
  for (const [key, head] of Object.entries(heads))
    if (key.split("/")[0] === id || head.by === id) {
      delete heads[key];
      changed = true;
    }
  return changed;
}

/**
 * The head a machine before #794 signed into its items: the longest it knew, its own or a longer
 * one an active device signed that its chain lacked, naming that device as `by`. Machines now sign
 * their own head and post nothing while they know a longer one; devices still read `by` heads.
 */
export function headToSign(heads: Heads, dir: Directory, entries: unknown[]): DirectoryHead {
  let best: DirectoryHead = { length: dir.length, head: dir.head };
  for (const [id, head] of Object.entries(heads))
    if (dir.members.get(id)?.active && !holdsHead(entries, head) && head.length > best.length)
      best = { length: head.length, head: head.head, by: id };
  return best;
}
