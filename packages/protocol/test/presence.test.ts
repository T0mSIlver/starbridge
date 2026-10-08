import { expect, test } from "bun:test";
import { AccountSettings, isPresent, PRESENCE_INPUT_MS, PUSH_HOLD_CHOICES } from "../src/index";

test("a screen is present only unlocked and used in the last minute", () => {
  expect(isPresent({ locked: false, idleMs: 0 })).toBe(true);
  expect(isPresent({ locked: false, idleMs: PRESENCE_INPUT_MS - 1 })).toBe(true);
  expect(isPresent({ locked: false, idleMs: PRESENCE_INPUT_MS })).toBe(false);
  expect(isPresent({ locked: true, idleMs: 0 })).toBe(false);
  // A clock that went backwards says nothing.
  expect(isPresent({ locked: false, idleMs: -5 })).toBe(false);
});

test("every hold time a client offers is one the server takes", () => {
  for (const pushHold of PUSH_HOLD_CHOICES)
    expect(AccountSettings.safeParse({ pushHold }).success).toBe(true);
  expect(AccountSettings.safeParse({ pushHold: 301 }).success).toBe(false);
  expect(AccountSettings.safeParse({ pushHold: 1.5 }).success).toBe(false);
});
