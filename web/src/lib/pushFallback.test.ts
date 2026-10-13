import { expect, test } from "bun:test";
import {
  applePush,
  closeStale,
  fallback,
  openPush,
  type Shown,
  type Unshown,
} from "./pushFallback";

const decision = JSON.stringify({ v: 1, kind: "decision", id: "d1", from: "devbox" });

test("Safari's push service is Apple's, whatever the path", () => {
  expect(applePush("https://web.push.apple.com/QGx")).toBe(true);
  expect(applePush("https://fcm.googleapis.com/fcm/send/x")).toBe(false);
  expect(applePush("not a url")).toBe(false);
});

test("a question that could not be opened shows the placeholder under its own tag, on every browser", () => {
  for (const apple of [true, false]) {
    expect(fallback(decision, "failed", apple)?.options).toMatchObject({
      body: "A question needs you",
      tag: "d:d1",
    });
    expect(fallback(decision, "late", apple)?.options.tag).toBe("d:d1");
  }
  const prompt = JSON.stringify({ v: 1, kind: "permission", id: "p1", from: "devbox" });
  expect(fallback(prompt, "failed", false)?.options.tag).toBe("p:p1");
  const waiting = JSON.stringify({ v: 1, kind: "waiting", id: "w1", from: "devbox" });
  expect(fallback(waiting, "failed", false)?.options.tag).toBe("open");
});

test("a push with nothing to show stays silent, except on Safari, which drops the subscription", () => {
  const answered = JSON.stringify({ v: 1, kind: "answered", id: "d1" });
  const posted = JSON.stringify({ v: 1, kind: "snooze", id: "z1", from: "phone", due: false });
  for (const [text, why] of [
    [decision, "empty"],
    [answered, "failed"],
    [posted, "failed"],
    ["not json", "empty"],
  ] as [string, Unshown][]) {
    expect(fallback(text, why, false)).toBeUndefined();
    expect(fallback(text, why, true)?.options).toMatchObject({ tag: "quiet", silent: true });
  }
});

/** Runs `openPush` with `open`, and returns what it shows and reports, in order. */
async function run(open: (seen: Shown) => Promise<void>, within = 20) {
  const log: string[] = [];
  await openPush(
    open,
    async (why, seen) => {
      log.push(`fallback ${why}`);
      seen.shown = true;
    },
    async (err) => {
      log.push(`failed ${err}`);
    },
    within,
  );
  return log;
}

test("a push shows a fallback when it ends without a notification, once it fails, or while late", async () => {
  expect(
    await run(async (seen) => {
      seen.shown = true;
    }),
  ).toEqual([]);
  expect(await run(async () => {})).toEqual(["fallback empty"]);
  expect(
    await run(async () => {
      throw new Error("fetch failed");
    }),
  ).toEqual(["failed Error: fetch failed", "fallback failed"]);
  // Still opening at the deadline: the placeholder now; the push's own notification replaces it.
  expect(
    await run(async (seen) => {
      await new Promise((r) => setTimeout(r, 60));
      seen.shown = true;
    }),
  ).toEqual(["fallback late"]);
  // Late, then failing: the placeholder already shows, so nothing more.
  expect(
    await run(async () => {
      await new Promise((r) => setTimeout(r, 60));
      throw new Error("slow");
    }),
  ).toEqual(["fallback late", "failed Error: slow"]);
});

test("the page closes the notifications of questions answered, settled or snoozed, and placeholders once it shows", async () => {
  const notes = ["d:a", "d:s", "d:z", "d:open", "d:later", "open", "quiet", "r:run"].map((tag) => ({
    tag,
    closed: false,
    close() {
      this.closed = true;
    },
  }));
  const reg = { getNotifications: async () => notes as unknown as Notification[] };
  const now = Date.parse("2026-10-12T10:00:00Z");
  const items = [
    { decision: { id: "a" }, answeredAt: "2026-10-12T09:00:00Z" },
    { decision: { id: "s" }, settled: "withdrawn" },
    { decision: { id: "z" } },
    { decision: { id: "open" } },
    { decision: { id: "later" } },
  ];
  const snoozes = {
    z: { until: "2026-10-12T11:00:00Z" },
    later: { until: "2026-10-12T09:00:00Z" },
  };
  const closed = () => notes.filter((n) => n.closed).map((n) => n.tag);
  await closeStale(reg, items, snoozes, false, now);
  expect(closed()).toEqual(["d:a", "d:s", "d:z"]);
  await closeStale(reg, items, snoozes, true, now);
  expect(closed()).toEqual(["d:a", "d:s", "d:z", "open", "quiet"]);
});
