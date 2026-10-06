import { expect, test } from "bun:test";
import { newestWins } from "./newest";

// The inbox (#547): a page load's read, then a push's read once the question was answered
// elsewhere. The push's read ends first; the load's, from before the answer, ends last.
test("an older read that ends last does not overwrite a newer one", () => {
  const begin = newestWins();
  let shown = "";
  const load = begin();
  const push = begin();
  if (push()) shown = "answered";
  if (load()) shown = "waiting";
  expect(shown).toBe("answered");
});

test("an older read lands when the newer one fails", () => {
  const begin = newestWins();
  const load = begin();
  begin(); // a push's read, which fails and never lands
  expect(load()).toBe(true);
});
