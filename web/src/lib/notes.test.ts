import { expect, test } from "bun:test";
import { itemPage } from "./notes";

test("a notification's click opens the item it is about, else the inbox", () => {
  expect(itemPage("d_1")).toBe("/?item=d_1");
  expect(itemPage("p/1 x")).toBe("/?item=p%2F1%20x");
  expect(itemPage(undefined)).toBe("/");
});
