// Detecting a withheld directory entry from the heads other members sign (PROTOCOL.md
// "Directory"). Devices sign theirs into answers and machines into every item, so each side can
// tell when the server serves it a shorter chain than a member it hears from has seen.
import { type Directory, holdsHead } from "./directory";
import type { DirectoryHead } from "./schemas";

/** The longest head each member signed, by member id. */
export type Heads = Record<string, DirectoryHead>;

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
  const known = heads[signer];
  const replace =
    !known ||
    head.length > known.length ||
    (holdsHead(entries, known) && !holdsHead(entries, head));
  if (replace) heads[signer] = head;
  return replace;
}

/**
 * A member active in `dir` that signed a head the chain `entries` lacks: the server is holding
 * back entries it has, or serving that member another chain. Undefined while none has.
 */
export function withheldBy(
  heads: Heads,
  dir: Directory,
  entries: unknown[],
): { id: string; head: DirectoryHead } | undefined {
  for (const [id, head] of Object.entries(heads))
    if (dir.members.get(id)?.active && !holdsHead(entries, head)) return { id, head };
  return undefined;
}

/**
 * The head a machine signs into its items: the longest it knows, its own or a longer one an
 * active device signed that its chain lacks, so the devices it posts to learn of it too.
 */
export function headToSign(heads: Heads, dir: Directory, entries: unknown[]): DirectoryHead {
  let best: DirectoryHead = { length: dir.length, head: dir.head };
  for (const [id, head] of Object.entries(heads))
    if (dir.members.get(id)?.active && !holdsHead(entries, head) && head.length > best.length)
      best = head;
  return best;
}
