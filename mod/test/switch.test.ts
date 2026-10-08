import { expect, test } from "bun:test";
import { wantsLoop } from "../hooks/switch.ts";

test("a session a host keeps open gets the loop; a run that ends with its turn does not (#863)", () => {
  expect(wantsLoop(true, undefined)).toBe(true);
  // Claude desktop's Code tab and IDEs run Claude Code through the SDK: not interactive to the engine.
  expect(wantsLoop(false, "claude-desktop")).toBe(true);
  expect(wantsLoop(false, "claude-vscode")).toBe(true);
  for (const oneShot of ["sdk-cli", "sdk-ts", "sdk-py", undefined])
    expect(wantsLoop(false, oneShot)).toBe(false);
});
