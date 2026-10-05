import { expect, test } from "bun:test";
import { clockTime, origin } from "./format";

test("a list row names the session, else the project of a decision asked outside one", () => {
  expect(origin({ session: "5423693e-a677-4f13", project: "proj" })).toBe("5423693e");
  expect(origin({ session: "x", sessionTitle: "Fix login", project: "proj" })).toBe("Fix login");
  expect(origin({ session: "", project: "proj" })).toBe("proj");
});

test("clockTime: the Clock setting overrides the browser's 12- or 24-hour choice", () => {
  const evening = new Date(2026, 9, 5, 22, 5);
  expect(clockTime(evening, "24")).toBe("22:05");
  expect(clockTime(evening, "12")).toMatch(/^10:05\s?PM$/i);
});
