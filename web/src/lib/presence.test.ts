import { expect, test } from "bun:test";
import { Beacon } from "./presence";

test("a visible page used in the last minute says present, beats, and says absent once hidden or idle", async () => {
  let now = 0;
  let visible = true;
  const sent: boolean[] = [];
  const b = new Beacon(
    async (p) => {
      sent.push(p);
    },
    () => visible,
    () => now,
  );
  // Visible alone is not enough: a laptop left open with the tab says nothing.
  await b.tick();
  expect(sent).toEqual([]);
  b.input();
  await Promise.resolve();
  expect(sent).toEqual([true]);
  now = 10_000;
  b.input();
  await b.tick();
  expect(sent).toEqual([true]);
  now = 30_000;
  await b.tick();
  expect(sent).toEqual([true, true]);
  now = 70_001;
  await b.tick();
  expect(sent).toEqual([true, true, false]);
  b.input();
  await Promise.resolve();
  visible = false;
  await b.tick();
  expect(sent).toEqual([true, true, false, true, false]);
});

test("a failed beat is tried again at the next check", async () => {
  let fail = true;
  const sent: boolean[] = [];
  const b = new Beacon(
    async (p) => {
      if (fail) throw new Error("offline");
      sent.push(p);
    },
    () => true,
    () => 0,
  );
  b.input();
  await b.tick();
  fail = false;
  await b.tick();
  expect(sent).toEqual([true]);
});
