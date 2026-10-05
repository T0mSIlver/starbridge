// One selection drives both the list highlight and the detail pane.
import { expect, test } from "bun:test";
import { afterAnswer, selectedId, step } from "./selection";

test("the first open row is selected until one is picked, and a pick survives new arrivals", () => {
  expect(selectedId(["a", "b"], undefined, "a")).toBe("a");
  expect(selectedId(["a", "b"], "b", "a")).toBe("b");
  // A decision arriving on top does not move the selection.
  expect(selectedId(["new", "a", "b"], "a", "new")).toBe("a");
  // A pick no longer listed falls back to the first open row, or to none.
  expect(selectedId(["a", "b"], "gone", "a")).toBe("a");
  expect(selectedId(["past"], undefined, undefined)).toBeUndefined();
});

test("J and K move one row and stop at the ends", () => {
  const ids = ["a", "b", "c"];
  expect(step(ids, "a", 1)).toBe("b");
  expect(step(ids, "b", -1)).toBe("a");
  expect(step(ids, "c", 1)).toBe("c");
  expect(step(ids, "a", -1)).toBe("a");
  expect(step([], undefined, 1)).toBeUndefined();
});

test("answering moves to the next open decision, else the previous, else stays", () => {
  expect(afterAnswer(["a", "b", "c"], "b")).toBe("c");
  expect(afterAnswer(["a", "b"], "b")).toBe("a");
  expect(afterAnswer(["a"], "a")).toBeUndefined();
});
