/**
 * What the Pi extension and the opencode plugin need from Node to run the answer loop and the
 * permission hook outside Claude Code's mod host: the agent's socket, commands, and timers that
 * never keep the harness from exiting.
 */
import { spawn } from "node:child_process";
import { request } from "node:http";
import { HEADERS } from "./agent.ts";

/** The mod's host aborts a call after 30 s; the loop is built around that limit. */
const CALL_MS = 30_000;

/** How long the CLI gets once stopped: it reports the prompt settled within 5 s. */
export const STOP_MS = 10_000;

/** One HTTP call on the agent's unix socket. Rejects when it cannot connect or takes too long. */
export function socketFetch(socket: string, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath: socket,
        path,
        method,
        headers:
          payload === undefined ? HEADERS : { ...HEADERS, "content-type": "application/json" },
        timeout: CALL_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          text += d;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer in ${CALL_MS / 1000} s`)));
    req.on("error", reject);
    req.end(payload);
  });
}

/** Runs `argv`; never rejects, as the mod's `$.process.run`. */
export function runCommand(argv: string[], timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * `starbridge hook permission --agent <agent>` with `stdin`; resolves to what it printed. An
 * abort sends SIGTERM, which the CLI takes as the keyboard answering.
 */
export function permissionHook(
  agent: string,
  stdin: string,
  signal: AbortSignal,
  env: Record<string, string> = {},
) {
  return hookCommand(["permission", "--agent", agent], stdin, signal, env);
}

/** `starbridge hook <args>` with `stdin`; resolves to what it printed. An abort sends SIGTERM. */
export function hookCommand(
  args: string[],
  stdin: string,
  signal: AbortSignal,
  env: Record<string, string> = {},
) {
  return new Promise<string>((resolve) => {
    const child = spawn("starbridge", ["hook", ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    // The caller stops the CLI when the keyboard answers or it overran; one that ignores
    // SIGTERM is killed.
    let kill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
      kill.unref();
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop);
    child.on("error", () => resolve(""));
    child.on("close", () => {
      clearTimeout(kill);
      signal.removeEventListener("abort", stop);
      resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/** The CLI's verdict: allow, deny with the owner's message, or defer (it printed nothing). */
export type Verdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" };

/** The verdict in what the CLI printed: Claude Code's `PermissionRequest` decision, or none. */
export function verdictOf(stdout: string): Verdict {
  try {
    const d = (JSON.parse(stdout) as { hookSpecificOutput?: { decision?: unknown } })
      .hookSpecificOutput?.decision as { behavior?: unknown; message?: unknown } | undefined;
    if (d?.behavior === "allow") return { kind: "allow" };
    if (d?.behavior === "deny")
      return { kind: "deny", ...(typeof d.message === "string" ? { reason: d.message } : {}) };
  } catch {}
  return { kind: "defer" };
}

/** A sleep that never keeps the harness from exiting. */
export const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref();
  });
