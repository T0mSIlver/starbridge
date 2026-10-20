import { expect, test } from "bun:test";
import { ASK_CONTENT_FIELDS, ASK_ROUTE_FIELDS, pickFields } from "../src/decisions";

test("an ask from a file or a client keeps only the fields its entry point names, so a new host-only field starts closed", () => {
  const given = {
    question: "Merge?",
    options: ["Yes", "No"],
    project: "p",
    // What only the environment or a hook of this process sets.
    codex: { home: "/h", bin: "/b" },
    headless: true,
    held: true,
    picker: "t1",
    nextStep: "s1",
    askedAt: "2026-10-20T10:00:00Z",
    newHostField: 1,
  };
  expect(pickFields(given, ASK_CONTENT_FIELDS)).toEqual({
    question: "Merge?",
    options: ["Yes", "No"],
    project: "p",
  });
  expect(pickFields(given, [...ASK_CONTENT_FIELDS, ...ASK_ROUTE_FIELDS])).toEqual({
    question: "Merge?",
    options: ["Yes", "No"],
    project: "p",
    codex: { home: "/h", bin: "/b" },
    headless: true,
  });
  for (const bad of [null, "text", 3, undefined])
    expect(pickFields(bad, ASK_CONTENT_FIELDS)).toEqual({});
});
