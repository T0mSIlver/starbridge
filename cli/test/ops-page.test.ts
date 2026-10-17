import { expect, test } from "bun:test";
import {
  type Bug,
  bugsByVersion,
  compareVersions,
  type Facts,
  next,
  nextNightly,
  promotion,
  render,
} from "../scripts/ops-page";
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
  tipBuild: { version: "0.1.8-tip.85", sha: "f".repeat(40), at: "2026-10-15T02:52:37Z" },
  macSince: 2,
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

test("promotion is the newest rc's time plus 4 hours, in Paris and UTC", () => {
  const p = promotion(facts());
  expect(p.earliest?.toISOString()).toBe("2026-10-14T01:21:15.000Z");
  expect(p.becomes).toBe("0.1.7");
  expect(p.nextRc).toBe("0.1.8-rc.1");
  expect(p.verdict).toBe("Waiting: 1 h left on the clock");
  expect(render(facts())).toContain("Wed 14 Oct, 03:21 Paris, 01:21 UTC");
  expect(next(facts()).join("\n")).not.toContain("needs a day");
});

test("a newer rc restarts the clock", () => {
  const newer = record(releases, "0.1.7-rc.3", { github: true }, "2026-10-14T09:00:00Z");
  const p = promotion(facts({ releases: newer, now: new Date("2026-10-14T10:00:00Z") }));
  expect(p.candidate?.version).toBe("0.1.7-rc.3");
  expect(p.earliest?.toISOString()).toBe("2026-10-14T13:00:00.000Z");
  expect(p.verdict).toBe("Waiting: 3 h left on the clock");
  // With rc.2 alone the clock would have run out.
  expect(promotion(facts({ now: new Date("2026-10-14T10:00:00Z") })).verdict).toBe(
    "Ready for your yes",
  );
});

test("a promotion waiting for the owner's yes holds new rcs", () => {
  const ready = facts({ now: new Date("2026-10-14T10:00:00Z") });
  expect(promotion(ready).holdsNewRc).toBe(true);
  expect(render(ready)).toContain("No new rc while this waits for your yes");
  expect(render(facts())).not.toContain("No new rc while");
  expect(render({ ...ready, openRegressions: 1 })).not.toContain("No new rc while");
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

test("the Mac app's main is the newest tip build, and says what is not built yet (#1802)", () => {
  const html = render(facts());
  expect(html).toContain("0.1.8-tip.85");
  expect(html).toContain("ffffffff");
  expect(html).toContain("Thu 15 Oct, 04:52 Paris, 02:52 UTC");
  expect(next(facts()).join("\n")).toContain("2 commits not built since 0.1.8-tip.85");
  expect(next(facts({ macSince: 0 })).join("\n")).toContain(
    "Mac main: builds on each merge that touches the app; none waiting",
  );
  expect(next(facts({ macSince: 2, macChanged: false })).join("\n")).toContain("none waiting");
  expect(next(facts({ macSince: undefined })).join("\n")).not.toContain("since 0.1.8");
  expect(render(facts({ tipBuild: undefined }))).toContain("None yet");
});

const bug = (over: Partial<Bug>): Bug => ({
  number: 1,
  title: "A bug",
  open: true,
  foundIn: "0.1.7-rc.2",
  regression: false,
  ...over,
});

test("versions sort with an rc before its final and unknown last", () => {
  const sorted = ["unknown", "0.1.8-rc.2", "0.1.7", "0.1.8-rc.10", "0.1.8", "0.1.8-rc.3"].sort(
    compareVersions,
  );
  expect(sorted).toEqual(["0.1.7", "0.1.8-rc.2", "0.1.8-rc.3", "0.1.8-rc.10", "0.1.8", "unknown"]);
});

test("bugs group by the version they were found in, newest first, and the newest rc always shows (#1890)", () => {
  const f = facts({
    bugs: [
      bug({ number: 5, open: false }),
      bug({ number: 3 }),
      bug({ number: 9, foundIn: "unknown" }),
    ],
  });
  expect(bugsByVersion(f).map((g) => [g.version, g.bugs.map((b) => b.number)])).toEqual([
    ["0.1.7-rc.2", [3, 5]],
    ["unknown", [9]],
  ]);
  expect(bugsByVersion(facts({ bugs: [] })).map((g) => g.version)).toEqual(["0.1.7-rc.2"]);
});

test("the page says where each bug stands: open, fixed in a tag, on main, or closed by hand", () => {
  const html = render(
    facts({
      regressions: [bug({ number: 3, regression: true })],
      bugs: [
        bug({ number: 3, regression: true }),
        bug({ number: 4, open: false, fixedIn: "v0.1.7-rc.3" }),
        bug({ number: 5, open: false }),
        bug({ number: 6, open: false, closedByHand: true }),
        bug({ number: 7, title: "<script>x</script>" }),
      ],
    }),
  );
  expect(html).toContain("5 found, 2 open");
  expect(html).toContain("fixed in <a");
  expect(html).toContain(">v0.1.7-rc.3</a>");
  expect(html).toContain("fixed on main, in no tag yet");
  expect(html).toContain("closed without a fix");
  expect(html).toContain("&#60;script&#62;");
  expect(html).not.toContain("<script>x");
  expect(render(facts({ regressions: [], bugs: [] }))).toContain("None open.");
  expect(render(facts())).toContain("GitHub did not answer: bugs unknown.");
});
