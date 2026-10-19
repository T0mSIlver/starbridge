// The ordering rules against vectors/rules.json, which the clients' tests read too (#2103).
import { expect, test } from "bun:test";
import { laterSnooze, laterWaiting, snoozeStamp } from "../src/order";
import rules from "../vectors/rules.json";

const { order } = rules;

test.each(order.snooze.map((c) => [c.name, c] as const))("snooze: %s", (_, c) => {
  expect(laterSnooze("kept" in c ? c.kept : undefined, c.next)).toBe(c.later);
});

test.each(order.waiting.map((c) => [c.name, c] as const))("waiting: %s", (_, c) => {
  const kept = "kept" in c ? (c.kept as { at: string; state: "waiting" | "working" }) : undefined;
  expect(laterWaiting(kept, c.next as { at: string; state: "waiting" | "working" })).toBe(c.later);
});

test.each(order.stamp.map((c) => [c.name, c] as const))("stamp: %s", (_, c) => {
  const last = "last" in c ? c.last : undefined;
  expect(snoozeStamp(Date.parse(c.now), last, true)).toBe(c.seconds);
  expect(snoozeStamp(Date.parse(c.now), last)).toBe(c.millis);
});
