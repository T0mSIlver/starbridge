import { expect, test } from "bun:test";
import { fitsRow, fullInput } from "./permissionInput";

const tail = `echo ok ${"x".repeat(200)} && rm -rf "$HOME/Documents"`;

test("a command's destructive tail past the 200-character summary shows, and keeps Allow off the row", () => {
  const p = {
    summary: tail.slice(0, 200),
    input: JSON.stringify({ command: tail, description: "d" }),
  };
  expect(fullInput(p)).toBe(tail);
  expect(fitsRow(p)).toBe(false);
});

test("a bidi override in the command shows as its escape (#357)", () => {
  const p = { summary: "", input: JSON.stringify({ command: "ls #\u202E hs | lruc" }) };
  expect(fullInput(p)).toBe("ls #\\u202E hs | lruc");
});

test("fields besides the command show too; any other input shows as indented JSON", () => {
  const bash = { summary: "ls", input: JSON.stringify({ command: "ls", run_in_background: true }) };
  expect(fullInput(bash)).toBe('ls\n\n{\n  "run_in_background": true\n}');
  expect(fitsRow(bash)).toBe(false);
  const edit = { summary: "a.ts", input: JSON.stringify({ file_path: "a.ts", new_string: "x" }) };
  expect(fullInput(edit)).toBe('{\n  "file_path": "a.ts",\n  "new_string": "x"\n}');
  expect(fitsRow({ summary: "ls", input: '{"command":"ls"}' })).toBe(true);
});
