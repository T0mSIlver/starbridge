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

test("in the desktop app, the Mac's idle time keeps a hidden page present, and away ends it at once", async () => {
  let now = 0;
  let screen: { away: boolean; idleMs: number | null } | null = { away: false, idleMs: 5_000 };
  const sent: boolean[] = [];
  const b = new Beacon(
    async (p) => {
      sent.push(p);
    },
    () => false,
    () => now,
    () => false,
    () => screen,
  );
  // Hidden, but the owner works in another app.
  await b.tick();
  expect(sent).toEqual([true]);
  // Idle past the minute.
  screen = { away: false, idleMs: 60_000 };
  now = 10_000;
  await b.tick();
  expect(sent).toEqual([true, false]);
  // Back, then locked: away even with input on the page a moment ago.
  screen = { away: false, idleMs: 0 };
  await b.tick();
  b.input();
  screen = { away: true, idleMs: 0 };
  await b.tick();
  expect(sent).toEqual([true, false, true, false]);
  // Presence off: only the page's own use counts.
  screen = { away: false, idleMs: null };
  now = 80_000;
  await b.tick();
  expect(sent).toEqual([true, false, true, false]);
});
