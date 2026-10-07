/**
 * Codex sessions. Since Codex CLI 0.160 the interactive TUI runs its sessions in a shared
 * app-server daemon (feature `daemon_auto_start`, on by default), and `codex queue` adds a user
 * message to one of them: an idle session starts a turn with it, a busy one runs it next. The
 * agent delivers answers to Codex sessions that way, as the Claude Code mod submits them.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Ctx } from "./context";
import { killTree, spawnable, which } from "./platform";

export interface CodexSession {
  /** `CODEX_HOME` of the session, which holds the daemon's socket. */
  home: string;
  /** The `codex` on the session's PATH; the agent's service PATH may have none. */
  bin: string;
}

/**
 * Where the asking Codex session runs, read from the environment Codex gives its commands.
 * Undefined for a `codex exec` session: `codex queue` accepts a message for it, but nothing runs
 * that message once exec has returned.
 */
export function codexSession(env: Ctx["env"]): CodexSession | undefined {
  const home = codexHome(env);
  const bin = which(env, "codex");
  if (!home || !bin) return undefined;
  if (env.CODEX_THREAD_ID && codexThread(home, env.CODEX_THREAD_ID)?.origin === "exec")
    return undefined;
  return { home, bin };
}

/**
 * The thread an answer to the asking Codex session goes to: its `CODEX_THREAD_ID`, or for a
 * sub-agent the root thread that spawned it, since `codex queue` refuses sub-agent threads
 * (0.160: "direct app-server input is not allowed for multi-agent v2 sub-agents").
 */
export function codexAsker(env: Ctx["env"]): string | undefined {
  const id = env.CODEX_THREAD_ID;
  const home = codexHome(env);
  return (id && home && codexThread(home, id)?.root) || id;
}

function codexHome(env: Ctx["env"]): string | undefined {
  return env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : undefined);
}

/**
 * How Codex started thread `id`, from the first line of its rollout: `origin` "exec" for
 * `codex exec`, "interactive" for the TUI or an IDE, and `root`, the thread of the session it
 * belongs to (`session_id`), when that is another thread, as for a sub-agent. Undefined when the
 * rollout is not found. Thread ids are UUIDv7, so the id dates the `sessions/YYYY/MM/DD` folder
 * (local time) the rollout is in.
 */
export function codexThread(
  home: string,
  id: string,
): { origin: "exec" | "interactive"; root?: string } | undefined {
  const ms = Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
  if (!Number.isFinite(ms)) return undefined;
  for (const offset of [0, -1, 1]) {
    const d = new Date(ms + offset * 86_400_000);
    const dir = join(
      home,
      "sessions",
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    let name: string | undefined;
    try {
      name = readdirSync(dir).find((f) => f.endsWith(`-${id}.jsonl`));
    } catch {}
    if (!name) continue;
    // The session_meta line can hold long instructions; its first fields are enough.
    const head = Buffer.alloc(8192);
    let n = 0;
    try {
      const fd = openSync(join(dir, name), "r");
      n = readSync(fd, head, 0, head.length, 0);
      closeSync(fd);
    } catch {
      return undefined;
    }
    const text = head.subarray(0, n).toString("utf8");
    const origin = /"originator":"([^"]*)"/.exec(text)?.[1];
    const source = /"source":"([^"]*)"/.exec(text)?.[1];
    if (origin === undefined && source === undefined) return undefined;
    const root = /"session_id":"([0-9a-f-]{36})"/.exec(text)?.[1];
    return {
      origin: source === "exec" || origin === "codex_exec" ? "exec" : "interactive",
      ...(root && root !== id ? { root } : {}),
    };
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

/**
 * What the agent queues into a Codex session for an answer. `codex queue` takes the message
 * only as an argument, which other local users can read in /proc/<pid>/cmdline, so it names the
 * decision and the command that prints the answer, never the question or the answer.
 */
export function codexNotice(id: string): string {
  return `Starbridge has the owner's answer to ${id}: run \`starbridge wait ${id}\` to read it.`;
}

/** Queues `message` into Codex session `thread`; resolves to the error, or undefined. */
export function codexQueue(
  s: CodexSession,
  thread: string,
  message: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const start = spawnable(s.bin, ["queue", "--thread", thread, "--message", message]);
    const child = spawn(start.file, start.args, {
      windowsVerbatimArguments: start.windowsVerbatimArguments,
      env: { ...process.env, CODEX_HOME: s.home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => killTree(child), QUEUE_MS);
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
