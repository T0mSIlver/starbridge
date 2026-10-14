import { expect, test } from "bun:test";
import { record } from "../scripts/releases";

test("a recorded release keeps only known channels, newest first, and later runs fill in the rest", () => {
  let f = record(
    undefined,
    "0.1.6",
    { github: true, npm: true, commit: "abc", play: { track: "alpha", versionCode: 2010699 } },
    "2026-10-13T14:33:03Z",
  );
  f = record(
    f,
    "0.1.7-rc.1",
    { github: true, testflight: { build: "12.1" }, rollout: 20 },
    "2026-10-13T15:27:44Z",
  );
  expect(f.releases.map((e) => e.version)).toEqual(["0.1.7-rc.1", "0.1.6"]);
  expect(JSON.stringify(f)).not.toContain("abc");
  expect(JSON.stringify(f)).not.toContain("rollout");
  expect(f.releases[1]?.channels.play).toEqual({ track: "alpha", versionCode: 2010699 });
  const again = record(f, "0.1.7-rc.1", { npm: true }, "later");
  expect(again.releases[0]).toEqual({
    version: "0.1.7-rc.1",
    ring: "rc",
    shipped: "2026-10-13T15:27:44Z",
    channels: { github: true, testflight: { build: "12.1" }, npm: true },
  });
});

test("a version that is not one is refused", () => {
  expect(() => record(undefined, "main", {}, "x")).toThrow();
});
