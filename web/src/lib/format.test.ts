import { afterEach, expect, setSystemTime, test } from "bun:test";
import { CHECK_CONFIRM_MS } from "@starbridge/protocol";
import { addedLabels, clockTime, origin, shownCheck } from "./format";

afterEach(() => setSystemTime());

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

test("rows that share a name show the time they were added, so a machine paired again reads apart (#287)", () => {
  const at = (h: number) => new Date(2026, 9, 6, h, 32).toISOString();
  const labels = addedLabels(
    [
      { id: "m_old", name: "sandbox", addedAt: at(9) },
      { id: "m_new", name: "sandbox", addedAt: at(10) },
      { id: "m_mac", name: "mac mini", addedAt: at(11) },
    ],
    "24",
  );
  expect(labels.get("m_old")).toBe("added Oct\u00a06, 09:32");
  expect(labels.get("m_new")).toBe("added Oct\u00a06, 10:32");
  expect(labels.get("m_mac")).toBe("added Oct\u00a06");
});

test("Devices shows a machine's check code only while `starbridge pair` waits for it (#939)", () => {
  const added = new Date("2026-10-09T09:00:00Z");
  const machine = { check: "HYB9-MDSM-H3N5-PVAX", addedAt: added.toISOString() };
  setSystemTime(added);
  expect(shownCheck(machine)).toBe("HYB9-MDSM-H3N5-PVAX");
  setSystemTime(new Date(added.getTime() + CHECK_CONFIRM_MS - 1));
  expect(shownCheck(machine)).toBe("HYB9-MDSM-H3N5-PVAX");
  setSystemTime(new Date(added.getTime() + CHECK_CONFIRM_MS));
  expect(shownCheck(machine)).toBeUndefined();
  expect(shownCheck({ addedAt: added.toISOString() }, added.getTime())).toBeUndefined();
});
