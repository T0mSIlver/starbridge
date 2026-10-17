import { expect, test } from "bun:test";
import { foundIn, plan } from "../scripts/found-in";

const form = (version: string, more = "") =>
  `### What happened\n\nIt broke.\n\n### Version\n\n${version}\n\n### Steps to reproduce\n\n${more}`;

test("an rc, a final and a tip build give their label", () => {
  expect(foundIn(form("0.1.8-rc.2"))).toBe("found-in:0.1.8-rc.2");
  expect(foundIn(form("v0.1.8"))).toBe("found-in:0.1.8");
  expect(foundIn(form("0.1.8-tip.85"))).toBe("found-in:0.1.8-tip.85");
});

test("the version is found in what a reporter pastes around it", () => {
  expect(foundIn(form("starbridge 0.1.8-rc.2 (linux-x64)"))).toBe("found-in:0.1.8-rc.2");
  expect(foundIn(form("Android 0.1.8-rc.2+build7."))).toBe("found-in:0.1.8-rc.2");
  expect(foundIn(form("It is 0.1.8."))).toBe("found-in:0.1.8");
  expect(foundIn(form("0.1.8-rc.2\r"))).toBe("found-in:0.1.8-rc.2");
});

test("garbage, an empty field and a missing field are unknown", () => {
  for (const v of [
    "latest",
    "No response",
    "",
    "0.1",
    "1.2.3.4",
    "0.1.8-beta",
    "0.1.8-rc",
    "x0.1.8",
  ])
    expect(foundIn(form(v))).toBe("found-in:unknown");
  expect(foundIn("just a description 0.1.8")).toBe("found-in:unknown");
  expect(foundIn(null)).toBe("found-in:unknown");
  expect(foundIn(undefined)).toBe("found-in:unknown");
});

test("only the Version field counts, not a version elsewhere in the body", () => {
  expect(foundIn(form("none", "worked on 0.1.7"))).toBe("found-in:unknown");
  expect(foundIn(`### Versions\n\n0.1.8\n`)).toBe("found-in:unknown");
  expect(foundIn(`### Version\n\n0.1.8-rc.2`)).toBe("found-in:0.1.8-rc.2");
});

test("injected text never reaches a label: only the matched version does", () => {
  expect(foundIn(form("0.1.8-rc.2$(curl evil)\n`id`"))).toBe("found-in:0.1.8-rc.2");
  expect(foundIn(form('"; rm -rf / #'))).toBe("found-in:unknown");
  expect(foundIn(form("$(id) 0.1.8"))).toBe("found-in:0.1.8");
});

test("an edit moves the label, and never removes one set by hand", () => {
  expect(plan(form("0.1.8-rc.2"), ["bug"])).toEqual({ add: "found-in:0.1.8-rc.2", remove: [] });
  expect(plan(form("0.1.8-rc.2"), ["bug", "found-in:unknown"])).toEqual({
    add: "found-in:0.1.8-rc.2",
    remove: ["found-in:unknown"],
  });
  expect(plan(form("0.1.8-rc.3"), ["found-in:0.1.8-rc.2"])).toEqual({
    add: "found-in:0.1.8-rc.3",
    remove: ["found-in:0.1.8-rc.2"],
  });
  expect(plan(form("0.1.8-rc.2"), ["found-in:0.1.8-rc.2"])).toEqual({ add: undefined, remove: [] });
  expect(plan(form("junk"), ["found-in:0.1.8-rc.2"])).toEqual({ remove: [] });
  expect(plan(form("junk"), ["bug"])).toEqual({ add: "found-in:unknown", remove: [] });
});
