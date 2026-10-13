// The one decision selected in the inbox's list and detail panes, by id.

/** The picked id while it is listed, else `fallback`: the first open one, if any. */
export function selectedId(
  ids: string[],
  picked: string | undefined,
  fallback: string | undefined,
): string | undefined {
  return picked !== undefined && ids.includes(picked) ? picked : fallback;
}

/** The id `by` rows away from `id`, stopping at either end (J is +1, K is -1). */
export function step(ids: string[], id: string | undefined, by: number): string | undefined {
  const at = id === undefined ? -1 : ids.indexOf(id);
  return ids[Math.min(Math.max(at + by, 0), ids.length - 1)];
}

/**
 * Where the selection goes once `id` is answered and leaves the open list: the next open one, or
 * none after the last, so the detail pane empties (#214).
 */
export function afterAnswer(openIds: string[], id: string): string | undefined {
  const at = openIds.indexOf(id);
  if (at < 0) return id;
  return openIds[at + 1] ?? openIds[at - 1];
}

/**
 * Under 1100 px, the item that opens in place of `id` once it is answered: with a mouse, the one
 * the wide layout would select; on a touch screen none, so the list comes back, since a tap
 * meant for the answered card could land on the next one's buttons (Tom, 2026-10-12, #1432).
 */
export function afterAnswerNarrow(
  openIds: string[],
  id: string,
  fine: boolean,
): string | undefined {
  if (!fine) return undefined;
  const next = afterAnswer(openIds, id);
  return next === id ? undefined : next;
}
