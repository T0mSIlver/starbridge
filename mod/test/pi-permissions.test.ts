import { expect, test } from "bun:test";
import { authorize, hookInput } from "../pi/permissions.ts";

const ALLOW = JSON.stringify({
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
});
const DENY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: "Use the staging remote" },
  },
});

/** A CLI hook that prints `out` after `ms`, or nothing at once when aborted, as on SIGTERM. */
function hook(out: string, ms: number) {
  const calls: { aborted: boolean }[] = [];
  return {
    calls,
    run: (_stdin: string, signal: AbortSignal) => {
      const call = { aborted: false };
      calls.push(call);
      return new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve(out), ms);
        signal.addEventListener("abort", () => {
          call.aborted = true;
          clearTimeout(t);
          resolve("");
        });
      });
    },
  };
}

/** A keyboard dialog that takes the prompt back after `ms`, unless closed first. */
function keyboard(ms: number) {
  const shown: { closed: boolean }[] = [];
  return {
    shown,
    open: (signal: AbortSignal) => {
      const dialog = { closed: false };
      shown.push(dialog);
      return new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          dialog.closed = true;
          clearTimeout(t);
        });
      });
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("a device's allow or deny decides, and closes the keyboard's dialog", async () => {
  for (const [out, verdict] of [
    [ALLOW, { kind: "allow" }],
    [DENY, { kind: "deny", reason: "Use the staging remote" }],
  ] as const) {
    const k = keyboard(10_000);
    const v = await authorize("{}", { hook: hook(out, 30).run, keyboard: k.open, sleep }, 10);
    expect(v).toEqual(verdict);
    expect(k.shown.map((d) => d.closed)).toEqual([true]);
  }
});

test("the keyboard takes it back: the CLI is stopped and pi-permission-system's dialog opens", async () => {
  const h = hook(ALLOW, 10_000);
  const v = await authorize("{}", { hook: h.run, keyboard: keyboard(30).open, sleep }, 10);
  expect(v).toEqual({ kind: "defer" });
  expect(h.calls.map((c) => c.aborted)).toEqual([true]);
});

test("a CLI that defers at once (Starbridge off, unpaired) shows no dialog", async () => {
  const k = keyboard(10_000);
  const v = await authorize("{}", { hook: hook("", 0).run, keyboard: k.open, sleep }, 200);
  expect(v).toEqual({ kind: "defer" });
  expect(k.shown).toEqual([]);
});

test("Pi's bash call reaches the CLI as a command, other asks as their path or value", () => {
  expect(hookInput({ toolName: "bash", command: "git push" }, "s1", "/w/p")).toEqual({
    session_id: "s1",
    cwd: "/w/p",
    tool_name: "bash",
    tool_input: { command: "git push" },
  });
  expect(hookInput({ toolName: "write", path: "/etc/hosts" }, "s1", "/w").tool_input).toEqual({
    path: "/etc/hosts",
  });
  expect(
    hookInput(
      { payload: { request: { surface: "mcp", value: "github.create_issue" } } },
      "s1",
      "/w",
    ),
  ).toMatchObject({ tool_name: "mcp", tool_input: { value: "github.create_issue" } });
});
