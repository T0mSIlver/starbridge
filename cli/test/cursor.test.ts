import { expect, test } from "bun:test";
import { cursorAgentArgs } from "../src/cursor";

test("cursor-agent's flags come from the first ancestor that is cursor-agent", () => {
  expect(
    cursorAgentArgs([
      ["sh", "cli.sh"],
      ["/usr/bin/node", "/home/u/.local/share/cursor-agent/versions/1/index.js", "-p"],
      ["zsh"],
    ]),
  ).toContain("-p");
  expect(cursorAgentArgs([["sh"], ["bash"]])).toEqual([]);
});
