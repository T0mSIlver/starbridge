import { expect, test } from "bun:test";
import { subscribeFailure } from "./push";

const error = new DOMException("Registration failed - push service error", "AbortError");

test("Brave's push failure names the setting to turn on", () => {
  expect(subscribeFailure(error, true)).toContain("brave://settings/privacy");
});

test("other push failures show the browser's message with a hint", () => {
  const text = subscribeFailure(error, false);
  expect(text).toContain("Registration failed - push service error");
  expect(text).toContain("allowed for this site");
});
