import { expect, test } from "bun:test";
import { ITEM_KINDS, ItemKind, type Keep } from "../src";

// The server's sweep reads `keep`: an item no period ends would be stored for good.
test.each(ItemKind.options)("every %s item has an end", (kind) => {
  const def: { keep: Keep; re?: unknown } = ITEM_KINDS[kind];
  const { received, answered, unanswered, withRe } = def.keep;
  expect(Boolean(received || (answered && unanswered) || withRe)).toBe(true);
  // An item with no `re` would never find the item it goes with, and go at the next sweep.
  if (withRe) expect(def.re).toBeDefined();
});
