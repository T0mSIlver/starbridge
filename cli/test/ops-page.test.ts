import { expect, test } from "bun:test";
import { record } from "../scripts/releases";
import { type Facts, nextNightly, next, render } from "../scripts/ops-page";

const releases = record(
  record(undefined, "0.1.6", { github: true, npm: true }, "2026-10-13T14:33:03Z"),
  "0.1.7-rc.2",
  { github: true, play: { track: "alpha", versionCode: 2010702 } },
  "2026-10-13T21:21:15Z",
);
const facts = (over: Partial<Facts> = {}): Facts => ({
  now: new Date("2026-10-14T00:00:00Z"),
  releases,
  staging: "a".repeat(40),
  prod: "b".repeat(40),
  nightly: { sha: "c".repeat(40), at: "2026-10-13T21:55:57Z" },
  androidSince: 3,
  stagingSinceRc: 5,
  commits: { "0.1.6": "d".repeat(40), "0.1.7-rc.2": "e".repeat(40) },
  openRegressions: 0,
  iosMainOn: false,
  playProduction: false,
  ...over,
});

test("the nightly is the next 03:00 UTC, shown in Paris and UTC", () => {
  expect(nextNightly(new Date("2026-10-14T00:00:00Z")).toISOString()).toBe("2026-10-14T03:00:00.000Z");
  expect(nextNightly(new Date("2026-10-14T03:00:00Z")).toISOString()).toBe("2026-10-15T03:00:00.000Z");
  expect(next(facts())[0]).toContain("05:00 Paris, 03:00 UTC");
  expect(next(facts())[0]).toContain("will build (3 android/ commits since main-cccccccc)");
  expect(next(facts({ androidSince: 0 }))[0]).toContain("will skip");
});

test("promotion names its conditions", () => {
  expect(next(facts()).join("\n")).toContain("0.1.7-rc.2 has been on testers for 2 h");
  expect(next(facts({ openRegressions: 2 })).join("\n")).toContain("(2 open)");
});

test("the page shows main, rc and final and links the policy", () => {
  const html = render(facts());
  expect(html).toContain("main-cccccccc");
  expect(html).toContain("0.1.7-rc.2");
  expect(html).toContain("claude.ai/artifact/8HEhZtHRWRS5nECZB51MNk");
  expect(html).toContain("aaaaaaaa");
});
