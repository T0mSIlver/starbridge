import { expect, test } from "bun:test";
import { pbtxtString } from "../src/antigravity";

test("a prototext string reads back whatever Go's encoder escaped", () => {
  expect(pbtxtString('title: "a \\"b\\" \\\\ c\\nd"', "title")).toBe('a "b" \\ c\nd');
  expect(pbtxtString('subtitle:"no" title:"Caf\\303\\251 \\x41\\u00e9"', "title")).toBe("Café Aé");
  expect(pbtxtString('title:"Été"', "title")).toBe("Été");
  expect(pbtxtString("other:1", "title")).toBeUndefined();
});
