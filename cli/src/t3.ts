/**
 * T3 Code runs Claude Code, Codex and opencode sessions as threads (#2244). It gives each
 * thread's commands the thread's id in `T3CODE_THREAD_ID`, and `t3 thread send <thread> -` posts
 * a message read from stdin to that thread: a busy thread runs it as its next turn, a stopped one
 * is resumed, and the thread shows it as the owner's message. The local agent sends answers that
 * way where nothing else brings them into a thread T3 shows.
 */
import { spawn } from "node:child_process";
import type { Ctx } from "./context";
import { killTree, spawnable, which } from "./platform";

export const T3_THREAD = "T3CODE_THREAD_ID";

/**
 * T3's thread ids: UUIDs, or `mcp:launch:<hex>` for a thread an agent launched. The first
 * character is never `-`, so an id never reads as a flag of `t3 thread send`.
 */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

/** Where an answer goes through T3, as `ask` recorded it. */
export interface T3Route {
  thread: string;
  /**
   * A Claude Code session: its mod takes the answer while it runs, since it puts one into a
   * running turn; T3 brings it only once the mod is gone.
   */
  mod?: true;
}

/** A thread id `t3 thread send` may be given; anything else is not one. */
export function t3ThreadId(id: unknown): id is string {
  return typeof id === "string" && THREAD_ID.test(id);
}

/** The T3 thread the asking command runs in, or undefined outside T3. */
export function t3Thread(env: Ctx["env"]): string | undefined {
  const id = env[T3_THREAD];
  return t3ThreadId(id) ? id : undefined;
}

/** The `t3` on the agent's own PATH: never one an asking process names. */
export function t3Bin(env: Ctx["env"]): string | undefined {
  return which(env, "t3");
}

/** A send that has not returned by then is stopped, well before its claim on the answer expires. */
const SEND_MS = 20_000;

/**
 * Posts `text` to T3 thread `thread`, on stdin so no other local user reads it from the process's
 * arguments. Undefined once T3 took it, else why not.
 */
export function t3Send(bin: string, thread: string, text: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const start = spawnable(bin, ["thread", "send", thread, "-"]);
    const child = spawn(start.file, start.args, {
      windowsVerbatimArguments: start.windowsVerbatimArguments,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => killTree(child), SEND_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(e.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const last = stderr.trim().split("\n").at(-1) ?? "";
      resolve(code === 0 ? undefined : last || `t3 thread send exited ${code}`);
    });
    // A `t3` that exits before reading its input closes the pipe: `close` reports why.
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}
