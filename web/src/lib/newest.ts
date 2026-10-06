/**
 * Orders reads that overlap (#547): each takes a turn as it starts listing, and its result lands
 * only when no read that took a later turn has landed. Every read merges what the server lists
 * after its base's cursor into that base, so each landed result is whole, and the newest-started
 * one wins: an older read that ends last cannot put back what a newer one moved on from.
 */
export function newestWins(): () => () => boolean {
  let started = 0;
  let landed = 0;
  return () => {
    const turn = ++started;
    return () => {
      if (turn < landed) return false;
      landed = turn;
      return true;
    };
  };
}
