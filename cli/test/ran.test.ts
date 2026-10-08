import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { agentPid, evalForm, type Proc, runs, untilRan } from "../src/ran";
import { until } from "./helpers";

const COMMAND = `sleep 3; echo 'it''s'; touch "x.txt"`;

/** How Claude Code 2.1.294's Bash tool runs a command (probe of 2026-10-08). */
const toolShell = (command: string) => [
  "/usr/bin/zsh",
  "-c",
  `source /home/dev/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && ${evalForm(command)} < /dev/null && pwd -P >| /tmp/claude-272f-cwd`,
];

test("only a shell running the eval form is the call; a program handed the command as data is not", () => {
  const shell = { pid: 9, ppid: 2, argv: toolShell(COMMAND) };
  expect(runs(shell, COMMAND)).toBe(true);
  expect(runs(shell, "sleep 3")).toBe(false);
  expect(runs({ pid: 9, ppid: 2, argv: ["sh", "-c", "cli.sh hook permission"] }, COMMAND)).toBe(
    false,
  );
  // A background job handed the command as data, even in its eval form.
  expect(runs({ pid: 9, ppid: 2, argv: ["rg", COMMAND, "logs"] }, COMMAND)).toBe(false);
  expect(runs({ pid: 9, ppid: 2, argv: ["rg", evalForm(COMMAND)] }, COMMAND)).toBe(false);
  // `ps` gives the arguments as one string.
  expect(runs({ pid: 9, ppid: 2, argv: [toolShell(COMMAND).join(" ")] }, COMMAND)).toBe(true);
});

test("Claude Code is the hook's nearest ancestor that is not a shell", () => {
  const procs: Proc[] = [
    { pid: 2, ppid: 1, argv: ["/home/dev/.local/bin/claude", "--resume", "x"] },
    { pid: 3, ppid: 2, argv: ["/bin/sh", "-c", "sh cli.sh hook permission"] },
  ];
  expect(agentPid(procs, 3)).toBe(2);
  expect(agentPid(procs, 2)).toBe(2);
  expect(agentPid(procs, 99)).toBeUndefined();
});

test("the watch fires when the call starts under Claude Code, not for a run from before (#866)", async () => {
  const procs: Proc[] = [
    { pid: 2, ppid: 1, argv: ["claude"] },
    { pid: 3, ppid: 2, argv: ["/bin/sh", "-c", "hook"] },
    // The same command, already running when the prompt opened.
    { pid: 4, ppid: 2, argv: toolShell(COMMAND) },
  ];
  const watch = untilRan(undefined, COMMAND, async () => procs, 3);
  await Bun.sleep(1_200);
  expect(watch.signal.aborted).toBe(false);
  // Under another program: another session's run of the same command.
  procs.push({ pid: 5, ppid: 1, argv: toolShell(COMMAND) });
  await Bun.sleep(1_200);
  expect(watch.signal.aborted).toBe(false);
  procs.push(
    { pid: 6, ppid: 2, argv: ["bwrap", "--"] },
    { pid: 7, ppid: 6, argv: toolShell(COMMAND) },
  );
  await until(async () => watch.signal.aborted, 5_000);
  watch.stop();
});

test.skipIf(process.platform === "win32")(
  "it finds a real shell started under this process",
  async () => {
    const command = `sleep 5; echo '${process.pid}'`;
    const watch = untilRan(undefined, command, undefined, process.pid);
    await Bun.sleep(700);
    expect(watch.signal.aborted).toBe(false);
    const child = spawn("sh", ["-c", `${evalForm(command)} </dev/null`]);
    try {
      await until(async () => watch.signal.aborted, 5_000);
    } finally {
      child.kill();
      watch.stop();
    }
  },
);
