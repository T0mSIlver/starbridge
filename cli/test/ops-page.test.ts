import { expect, test } from "bun:test";
import { type Facts, next, nextNightly, promotion, render } from "../scripts/ops-page";
import { record } from "../scripts/releases";

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
  internalBuild: { sha: "c".repeat(40), at: "2026-10-13T21:55:57Z" },
  androidSince: 3,
  stagingSinceRc: 5,
  commits: { "0.1.6": "d".repeat(40), "0.1.7-rc.2": "e".repeat(40) },
  openRegressions: 0,
  iosMainOn: false,
  ...over,
});

test("the iPhone nightly is the next 03:00 UTC, shown in Paris and UTC", () => {
  expect(nextNightly(new Date("2026-10-14T00:00:00Z")).toISOString()).toBe(
    "2026-10-14T03:00:00.000Z",
  );
  expect(nextNightly(new Date("2026-10-14T03:00:00Z")).toISOString()).toBe(
    "2026-10-15T03:00:00.000Z",
  );
  expect(next(facts({ iosMainOn: true }))[1]).toContain("05:00 Paris, 03:00 UTC");
});

test("Android main builds on each app merge and rc tag, and says what is not built yet (#1690)", () => {
  expect(next(facts())[0]).toContain("each merge that touches the app and each rc tag");
  expect(next(facts())[0]).toContain("3 commits not built since main-cccccccc");
  expect(next(facts({ androidSince: 0 }))[0]).toContain("none waiting");
  expect(next(facts({ androidSince: 2, androidChanged: false }))[0]).toContain("none waiting");
});

test("promotion is the newest rc's time plus a day, in Paris and UTC", () => {
  const p = promotion(facts());
  expect(p.earliest?.toISOString()).toBe("2026-10-14T21:21:15.000Z");
  expect(p.becomes).toBe("0.1.7");
  expect(p.nextRc).toBe("0.1.8-rc.1");
  expect(p.verdict).toBe("Waiting: 21 h left on the clock");
  expect(render(facts())).toContain("Wed 14 Oct, 23:21 Paris, 21:21 UTC");
  expect(next(facts()).join("\n")).not.toContain("needs a day");
});

test("a newer rc restarts the clock", () => {
  const newer = record(releases, "0.1.7-rc.3", { github: true }, "2026-10-14T09:00:00Z");
  const p = promotion(facts({ releases: newer, now: new Date("2026-10-14T22:00:00Z") }));
  expect(p.candidate?.version).toBe("0.1.7-rc.3");
  expect(p.earliest?.toISOString()).toBe("2026-10-15T09:00:00.000Z");
  expect(p.verdict).toBe("Waiting: 11 h left on the clock");
  // With rc.2 alone the clock would have run out.
  expect(promotion(facts({ now: new Date("2026-10-14T22:00:00Z") })).verdict).toBe(
    "Ready for your yes",
  );
});

test("an open regression blocks promotion; no candidate once the rc is a final", () => {
  const late = new Date("2026-10-16T00:00:00Z");
  expect(promotion(facts({ now: late, openRegressions: 1 })).verdict).toBe(
    "Blocked: 1 open regression",
  );
  expect(promotion(facts({ now: late, openRegressions: undefined })).verdict).toContain("unknown");
  const out = record(releases, "0.1.7", { github: true }, "2026-10-15T09:00:00Z");
  expect(promotion(facts({ releases: out })).candidate).toBeUndefined();
  expect(render(facts({ releases: out }))).toContain("Candidate: none");
});

test("the page shows main, rc and final and links the policy", () => {
  const html = render(facts());
  expect(html).toContain("main-cccccccc");
  expect(html).toContain("0.1.7-rc.2");
  expect(html).toContain("claude.ai/artifact/8HEhZtHRWRS5nECZB51MNk");
  expect(html).toContain("aaaaaaaa");
});
