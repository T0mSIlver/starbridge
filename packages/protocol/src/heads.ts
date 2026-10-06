// Detecting a withheld directory entry from the heads other members sign (PROTOCOL.md
// "Directory"). Devices sign theirs into answers and machines into every item, so each side can
// tell when the server serves it a shorter chain than a member it hears from has seen.
import { type Directory, holdsHead } from "./directory";
import type { DirectoryHead } from "./schemas";

/**
 * The longest head each signer vouched for, keyed by the signer, or by "signer/by" for a head it
 * passed on from member `by`.
 */
export type Heads = Record<string, DirectoryHead>;

/** The members a kept head counts on: its signer, and the member it came from. */
function vouchers(key: string): string[] {
  return key.split("/");
}

/**
 * Records the head `signer` signed into an item. A shorter head never replaces a longer one the
 * chain `entries` lacks, so replaying an older item cannot lift a hold. True when it changed.
 */
export function noteHead(
  heads: Heads,
  signer: string,
  head: DirectoryHead | undefined,
  entries: unknown[],
): boolean {
  if (!head) return false;
  const key = head.by && head.by !== signer ? `${signer}/${head.by}` : signer;
  const known = heads[key];
  const replace =
    !known ||
    head.length > known.length ||
    (holdsHead(entries, known) && !holdsHead(entries, head));
  if (replace) heads[key] = head;
  return replace;
}

/**
 * A kept head the chain `entries` lacks, while every member it counts on is active in `dir`:
 * the server is holding back entries it has, or serving that member another chain. Once the
 * chain revokes the signer, or the member it came from, the head counts no more, so a forged one
 * ends with its forger's revocation. Undefined while none counts.
 */
export function withheldBy(
  heads: Heads,
  dir: Directory,
  entries: unknown[],
): { id: string; head: DirectoryHead } | undefined {
  for (const [key, head] of Object.entries(heads)) {
    const ids = vouchers(key);
    if (ids.every((id) => dir.members.get(id)?.active) && !holdsHead(entries, head))
      return { id: ids.at(-1) as string, head };
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
