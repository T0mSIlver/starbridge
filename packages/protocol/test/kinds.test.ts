import { expect, test } from "bun:test";
import { ITEM_KINDS, ItemKind, type Keep, RETENTION_DAYS } from "../src";

// The server's sweep reads `keep`: an item no period ends would be stored for good.
test.each(ItemKind.options)("every %s item has an end", (kind) => {
  const def: { keep: Keep; re?: unknown } = ITEM_KINDS[kind];
  const { received, answered, unanswered, withRe } = def.keep;
  expect(Boolean(received || (answered && unanswered) || withRe)).toBe(true);
  // An item with no `re` would never find the item it goes with, and go at the next sweep.
  if (withRe) expect(def.re).toBeDefined();
});

test("the longest period any kind is kept is the one the CLI keeps what it asked for (#2017)", () => {
  const periods = ItemKind.options.flatMap((kind) => {
    const { received, answered, unanswered } = (ITEM_KINDS[kind] as { keep: Keep }).keep;
    return [received, answered, unanswered].flatMap((p) => (p ? [RETENTION_DAYS[p]] : []));
  });
  expect(Math.max(...periods)).toBe(RETENTION_DAYS.month);
  expect(RETENTION_DAYS).toEqual({ day: 1, week: 7, month: 30 });
});
