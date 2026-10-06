import { afterEach, expect, test } from "bun:test";
import { Analytics } from "@/components/Analytics";

const before = process.env.NEXT_PUBLIC_ANALYTICS;
afterEach(() => {
  if (before === undefined) delete process.env.NEXT_PUBLIC_ANALYTICS;
  else process.env.NEXT_PUBLIC_ANALYTICS = before;
});

test("a self-hosted build loads no analytics script, which would 404 on every page", () => {
  delete process.env.NEXT_PUBLIC_ANALYTICS;
  expect(Analytics()).toBeNull();
});

test("starbridge.run's build loads Umami's script", () => {
  process.env.NEXT_PUBLIC_ANALYTICS = "umami";
  expect(Analytics()?.props.src).toBe("/stats/script.js");
});
