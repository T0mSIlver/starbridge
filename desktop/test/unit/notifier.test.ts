import { expect, test } from "bun:test";
import type { Entry } from "../../src/bridge";
import { Notifier } from "../../src/notifier";

function entry(id: string, waiting = false): Entry {
  return { id, title: id, body: "", options: [], reply: false, waiting };
}

function setup(known: string[] = []) {
  const shown: string[] = [];
  const closed: string[] = [];
  const saved: string[][] = [];
  const n = new Notifier(
    (e) => {
      shown.push(`${e.id}${e.waiting ? " waiting" : ""}`);
      return { close: () => closed.push(e.id) };
    },
    known,
    (ids) => saved.push(ids),
  );
  return { n, shown, closed, saved };
}

test("each item notifies once, and closes when it leaves", () => {
  const { n, shown, closed, saved } = setup();
  n.update([entry("a"), entry("b")]);
  n.update([entry("a"), entry("b")]);
  n.update([entry("b")]);
  expect(shown).toEqual(["a", "b"]);
  expect(closed).toEqual(["a"]);
  expect(saved.at(-1)).toEqual(["b"]);
});

test("an item notifies again when its agent starts waiting, and when it comes back", () => {
  const { n, shown, closed } = setup();
  n.update([entry("a")]);
  n.update([entry("a", true)]);
  n.update([entry("a", true)]);
  n.update([]);
  n.update([entry("a", true)]);
  expect(shown).toEqual(["a", "a waiting", "a waiting"]);
  expect(closed).toEqual(["a", "a"]);
});

test("items notified before a restart stay quiet", () => {
  const { n, shown } = setup(["a"]);
  n.update([entry("a", true), entry("b")]);
  expect(shown).toEqual(["b"]);
});

test("an answered item's notification closes and does not come back while it is listed", () => {
  const { n, shown, closed } = setup();
  n.update([entry("a")]);
  n.close("a");
  n.update([entry("a")]);
  expect(shown).toEqual(["a"]);
  expect(closed).toEqual(["a"]);
});
