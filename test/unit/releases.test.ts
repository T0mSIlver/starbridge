import { expect, test } from "bun:test";
import {
  ahead,
  feedTags,
  feedUrl,
  newerVersion,
  pickRelease,
  ymlVersion,
} from "../../src/releases";

// Newest first, as GitHub's feed lists them: an rc after the latest final, that final's rc, a
// withdrawn final.
const TAGS = ["v0.2.0-rc.1", "v0.1.4", "v0.1.4-rc.3", "v0.1.3"];

test("an app follows finals, or rcs and finals, and never a withdrawn final", () => {
  expect(pickRelease("v0.1.4", TAGS, "stable")).toBe("v0.1.4");
  expect(pickRelease("v0.1.4", TAGS, "rc")).toBe("v0.2.0-rc.1");
  expect(pickRelease("v0.1.2", TAGS.slice(2), "rc")).toBe("v0.1.4-rc.3");
  expect(pickRelease("v0.1.4", ["v0.1.4-rc.9"], "rc")).toBe("v0.1.4");
  expect(pickRelease(null, [], "stable")).toBeNull();
});

test("Tip takes the tip build when it is the newest, and an rc or final that passed it", () => {
  expect(pickRelease("v0.1.4", TAGS, "tip", "0.2.0-tip.80")).toBe("v0.2.0-tip.80");
  // Only Tip reads the tip build.
  expect(pickRelease("v0.1.4", TAGS, "rc", "0.2.0-tip.80")).toBe("v0.2.0-rc.1");
  // An rc of the next version, and the tip build's own final, pass it.
  expect(pickRelease("v0.1.4", TAGS, "tip", "0.1.5-tip.70")).toBe("v0.2.0-rc.1");
  expect(pickRelease("v0.2.0", [], "tip", "0.2.0-tip.80")).toBe("v0.2.0");
  // No tip release yet, or a file that names no tip build.
  expect(pickRelease("v0.1.4", TAGS, "tip", null)).toBe("v0.2.0-rc.1");
  expect(pickRelease("v0.1.4", [], "tip", "0.3.0-rc.1")).toBe("v0.1.4");
  // A tip build is never read from the feed.
  expect(pickRelease("v0.1.4", ["v0.2.0-tip.9"], "tip")).toBe("v0.1.4");
});

test("versions order as electron-updater's semver does: rcs, tip builds, the final", () => {
  const order = ["0.1.7-rc.1", "0.1.7-rc.12", "0.1.7-tip.2", "0.1.7-tip.12", "0.1.7", "0.1.8-rc.1"];
  for (let i = 1; i < order.length; i++) {
    expect(newerVersion(order[i] as string, order[i - 1] as string)).toBe(true);
    expect(newerVersion(order[i - 1] as string, order[i] as string)).toBe(false);
  }
});

test("a version above its channel waits for the channel to pass it", () => {
  expect(ahead("0.1.7-tip.80", "rc")).toBe(true);
  expect(ahead("0.1.7-tip.80", "stable")).toBe(true);
  expect(ahead("0.1.7-rc.3", "stable")).toBe(true);
  expect(ahead("0.1.7-rc.3", "tip")).toBe(false);
  expect(ahead("0.1.7", "stable")).toBe(false);
});

test("the feed's tags are its release links", () => {
  const atom = `<entry><link rel="alternate" type="text/html" href="https://github.com/T0mSIlver/starbridge/releases/tag/v0.1.4-rc.3"/></entry>`;
  expect(feedTags(atom)).toEqual(["v0.1.4-rc.3"]);
});

test("each release is read from its own repository", () => {
  const releases = "https://github.com/T0mSIlver/starbridge";
  const tip = "https://github.com/T0mSIlver/starbridge-tip";
  expect(feedUrl("v0.1.7", releases, tip)).toBe(`${releases}/releases/download/v0.1.7/`);
  expect(feedUrl("v0.1.7-rc.3", releases, tip)).toBe(`${releases}/releases/download/v0.1.7-rc.3/`);
  expect(feedUrl("v0.1.7-tip.80", releases, tip)).toBe(`${tip}/releases/download/tip/`);
});

test("the tip build's version is read from its latest-mac.yml", () => {
  expect(ymlVersion("version: 0.1.7-tip.80\nfiles:\n  - url: x.zip\n")).toBe("0.1.7-tip.80");
  expect(ymlVersion("files: []\nversion: '0.1.7-tip.81'\n")).toBe("0.1.7-tip.81");
  expect(ymlVersion("<html>")).toBeNull();
});
