import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { THEME_SCRIPT } from "./themeScript";

// Runs the inline script as the browser does, with the page's root element and the app's bridge.
function run(bridge?: { titleBar?: string }) {
  const dataset: Record<string, string> = {};
  const window = { starbridgeDesktop: bridge };
  runInNewContext(THEME_SCRIPT, {
    window,
    document: { documentElement: { dataset } },
    localStorage: { getItem: () => null },
  });
  return dataset;
}

test("the Mac app's window marks the page as Mac before the first paint, a browser does not", () => {
  expect(run()).toEqual({});
  expect(run({})).toEqual({ platform: "mac" });
  expect(run({ titleBar: "inset" })).toEqual({ platform: "mac", titlebar: "inset" });
});
