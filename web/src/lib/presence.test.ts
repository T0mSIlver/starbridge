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

test("a failed beat is tried again a beat later, and an idle tab leaves a busy sibling's word", async () => {
  let now = 0;
  let tries = 0;
  const b = new Beacon(
    async () => {
      tries++;
      throw new Error("not-found");
    },
    () => true,
    () => now,
  );
  b.input();
  await b.tick();
  now = 10_000;
  await b.tick();
  expect(tries).toBe(1);
  now = 30_000;
  b.input();
  await b.tick();
  expect(tries).toBe(2);

  now = 0;
  const sent: boolean[] = [];
  const idle = new Beacon(
    async (p) => {
      sent.push(p);
    },
    () => true,
    () => now,
    () => true,
  );
  idle.input();
  await idle.tick();
  now = 61_000;
  await idle.tick();
  expect(sent).toEqual([true]);
});
