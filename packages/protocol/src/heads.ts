// Detecting a withheld directory entry from the heads other members sign (PROTOCOL.md
// "Directory"). Devices sign theirs into answers and machines into every item, so each side can
// tell when the server serves it a shorter chain than a member it hears from has seen.
import { type Directory, holdsHead } from "./directory";
import type { DirectoryHead } from "./schemas";

/**
 * The longest head each signer vouched for, keyed by the signer, by "signer/by" for a head it
 * passed on from member `by`, or by "signer/?" for one passed on from a member this chain does
 * not list yet: one such slot per signer, so storage stays bounded.
 */
export type Heads = Record<string, DirectoryHead>;

/**
 * Records the head `signer` signed into an item. A shorter head never replaces a longer one the
 * chain `entries` lacks, so replaying an older item cannot lift a hold. With `dir`, a `by` that
 * chain does not list goes in the signer's one unknown slot. True when it changed.
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
  const key = !by ? signer : dir && !dir.members.has(by) ? `${signer}/?` : `${signer}/${by}`;
  const known = heads[key];
  const replace =
    !known ||
    head.length > known.length ||
    (holdsHead(entries, known) && !holdsHead(entries, head));
  if (replace) heads[key] = head;
  return replace;
}

/**
 * A kept head the chain `entries` lacks, signed by a member active in `dir`, and passed on from
 * no member `dir` lists as revoked: the server is holding back entries it has, or serving that
 * member another chain. A `by` the chain does not list counts, since its `add` may be what the
 * server holds back; once the chain revokes it, or the signer, the head counts no more, so a
 * forged one ends with its forger's revocation. Undefined while none counts.
 */
export function withheldBy(
  heads: Heads,
  dir: Directory,
  entries: unknown[],
): { id: string; by?: string; head: DirectoryHead } | undefined {
  for (const [key, head] of Object.entries(heads)) {
    const id = key.split("/")[0] as string;
    const by = head.by && head.by !== id ? head.by : undefined;
    if (!dir.members.get(id)?.active) continue;
    if (by && dir.members.get(by)?.active === false) continue;
    if (!holdsHead(entries, head)) return { id, ...(by ? { by } : {}), head };
  }
  return undefined;
}

/**
 * The head a machine signs into its items: the longest it knows, its own or a longer one an
 * active device signed that its chain lacks, naming that device as `by`, so the devices it posts
 * to learn of it too, and drop it once they revoke that device.
 */
export function headToSign(heads: Heads, dir: Directory, entries: unknown[]): DirectoryHead {
  let best: DirectoryHead = { length: dir.length, head: dir.head };
  for (const [id, head] of Object.entries(heads))
    if (dir.members.get(id)?.active && !holdsHead(entries, head) && head.length > best.length)
      best = { length: head.length, head: head.head, by: id };
  return best;
}
