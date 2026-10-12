import { expect, test } from "bun:test";
import { baseTag, parseNotes, prNumber, render } from "../scripts/release-notes";

const TAGS = ["v0.1.2", "v0.1.3-rc.1", "v0.1.3", "v0.1.4-rc.1", "v0.1.4-rc.2", "v0.1.4-rc.3"];

test("a final starts from the previous final, an rc from the tag before it", () => {
  expect(baseTag("0.1.4", TAGS)).toBe("v0.1.3");
  expect(baseTag("0.1.4-rc.3", TAGS)).toBe("v0.1.4-rc.2");
  expect(baseTag("0.1.4-rc.1", TAGS)).toBe("v0.1.3");
  expect(baseTag("0.1.2", TAGS)).toBeUndefined();
});

test("the pull request is the subject's last (#n)", () => {
  expect(prNumber("ask: a fix (#1037) (#1038)")).toBe(1038);
  expect(prNumber("a direct commit")).toBeUndefined();
});

test("notes come from the Release notes section, one per known product", () => {
  const body = `Closes #1.

Why.

## Release notes

<!-- One line per product: "Android: …" -->
- Android: Cards open faster.
web: A fix.
Phone: a typo

## Checks

- Android: not a note`;
  expect(parseNotes(body, 7)).toEqual({
    notes: [
      { product: "Android", text: "Cards open faster.", pr: 7 },
      { product: "Web", text: "A fix.", pr: 7 },
    ],
    unknown: ["Phone: a typo"],
  });
  expect(parseNotes("## Release notes\n\nNone\n")).toEqual({ notes: [], unknown: [] });
  expect(parseNotes("No section.")).toBeUndefined();
});

test("a None line that says why is no note and no warning", () => {
  expect(parseNotes("## Release notes\n\nNone: the iPhone app is not released yet\n")).toEqual({
    notes: [],
    unknown: [],
  });
});

test("no HTML comment survives, even one split around another or left open", () => {
  const body = "## Release notes\n\n- Web: A <!<!-- x -->-- y --> fix.\n- Android: Kept. <!-- open";
  const notes = parseNotes(body)?.notes.map((n) => n.text);
  expect(notes).toEqual(["A  fix.", "Kept."]);
  expect(notes?.join("")).not.toContain("<!--");
});

test("the body has a section per product with notes, in a fixed order, then every pull request folded", () => {
  const notes = render(
    [
      { subject: "Web: a fix (#2)", pr: 2, body: "## Release notes\nWeb: A fix." },
      { subject: "Android: cards (#3)", pr: 3, body: "## Release notes\nAndroid: Cards." },
      { subject: "CI: faster (#4)", pr: 4, body: "## Release notes\nNone" },
    ],
    "v1.0.0...v1.0.1",
    "o/r",
  );
  expect(notes).toBe(`### Android

- Cards. (#3)

### Web

- A fix. (#2)

<details><summary>All pull requests (3)</summary>

- Web: a fix (#2)
- Android: cards (#3)
- CI: faster (#4)

**Full Changelog**: https://github.com/o/r/compare/v1.0.0...v1.0.1

</details>
`);
});
