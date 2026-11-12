import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { isAppPage, itemPage } from "./notes";

test("a notification's click opens the item it is about, else the inbox", () => {
  expect(itemPage("d_1")).toBe("/?item=d_1");
  expect(itemPage("p/1 x")).toBe("/?item=p%2F1%20x");
  expect(itemPage(undefined)).toBe("/");
});

test("every page of the app takes a notification's click, and no page outside it does", () => {
  const routes = readdirSync(new URL("../app/(main)", import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `/${d.name}`);
  for (const path of ["/", ...routes, "/settings/devices/add"])
    expect([path, isAppPage(`https://s.test${path}?item=d_1`)]).toEqual([path, true]);
  for (const path of ["/docs", "/docs/cli", "/privacy", "/terms", "/app/auth", "/sample", "/pairs"])
    expect([path, isAppPage(`https://s.test${path}`)]).toEqual([path, false]);
});
