import { expect, test } from "bun:test";
import { macHours, regionHours } from "../../src/clock";

const defaults = (d: Record<string, string>) => (k: string) => d[k] ?? "";

test("the 24-hour switch decides, either way, whatever the region reads", () => {
  expect(macHours(defaults({ AppleICUForce24HourTime: "1" }), "en-US")).toBe("24");
  expect(macHours(defaults({ AppleICUForce12HourTime: "1" }), "fr-FR")).toBe("12");
  expect(macHours(defaults({ AppleICUForce24HourTime: "0" }), "fr-FR")).toBe("12");
});

test("with the switch at its default, the region decides, a region override first (#1705)", () => {
  expect(macHours(defaults({}), "en-US")).toBe("12");
  expect(macHours(defaults({}), "fr-FR")).toBe("24");
  expect(macHours(defaults({}), "en-GB")).toBe("24");
  // The Mac mini's locale: English, with France's formats.
  expect(macHours(defaults({}), "en-US@rg=frzzzz")).toBe("24");
});

test("a locale without a region reads its language's hours; an unreadable one reads 24", () => {
  expect(regionHours("fr")).toBe("24");
  expect(regionHours("")).toBe("24");
  expect(regionHours("!!@@")).toBe("24");
});
