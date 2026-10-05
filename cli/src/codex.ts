/**
 * Codex sessions. Since Codex CLI 0.160 the interactive TUI runs its sessions in a shared
 * app-server daemon (feature `daemon_auto_start`, on by default), and `codex queue` adds a user
 * message to one of them: an idle session starts a turn with it, a busy one runs it next. The
 * agent delivers answers to Codex sessions that way, as the Claude Code mod submits them.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { delimiter, join } from "node:path";
import type { Ctx } from "./context";

export interface CodexSession {
  /** `CODEX_HOME` of the session, which holds the daemon's socket. */
  home: string;
  /** The `codex` on the session's PATH; the agent's service PATH may have none. */
  bin: string;
}

/** Where the asking Codex session runs, read from the environment Codex gives its commands. */
export function codexSession(env: Ctx["env"]): CodexSession | undefined {
  const home = env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : undefined);
  const bin = which("codex", env.PATH);
  return home && bin ? { home, bin } : undefined;
}

function which(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (Bun.file(p).size > 0) return p;
  }
  return undefined;
}

const CONNECT_MS = 1_000;

/** Whether the session's app-server daemon accepts connections, so `codex queue` can reach it. */
export function codexReachable(s: CodexSession): Promise<boolean> {
  const socket = join(s.home, "app-server-control", "app-server-control.sock");
  return new Promise((resolve) => {
    const c = createConnection(socket);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      c.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), CONNECT_MS);
    c.on("connect", () => done(true));
    c.on("error", () => done(false));
  });
}

const QUEUE_MS = 30_000;

/** Queues `message` into Codex session `thread`; resolves to the error, or undefined. */
export function codexQueue(
  s: CodexSession,
  thread: string,
  message: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(s.bin, ["queue", "--thread", thread, "--message", message], {
      env: { ...process.env, CODEX_HOME: s.home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), QUEUE_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(e.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const last = stderr.trim().split("\n").at(-1) ?? "";
      resolve(code === 0 ? undefined : last || `codex queue exited ${code}`);
    });
  });
}
