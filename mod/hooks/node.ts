/**
 * What the Pi extension and the opencode plugin need from Node to run the answer loop and the
 * permission hook outside Claude Code's mod host: the agent's socket, commands, and timers that
 * never keep the harness from exiting.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { HEADERS, isPortFile, PROOF_HEADER, portTarget, signCall } from "./agent.ts";
import { configDir } from "./poller.ts";

/**
 * On Windows a bare `starbridge` may be npm's `starbridge.cmd`, which only a shell starts, and
 * Node passes the arguments to cmd.exe unquoted: anything but plain words and ids is refused. A
 * path, as setup records, starts without one.
 */
const viaShell = (cmd: string) => process.platform === "win32" && !/[\\/]/.test(cmd);
const plain = (cmd: string, args: string[]) =>
  !viaShell(cmd) || args.every((a) => /^[\w.:@/=-]+$/.test(a));

/**
 * The CLI to start: the path setup recorded in the config folder, since an agent's PATH may lack
 * the install folder (#612), while that binary exists; else `starbridge` on the PATH.
 */
export function cli(env: Record<string, string | undefined> = process.env): string {
  try {
    const recorded = readFileSync(`${configDir(env)}/cli-path`, "utf8").trim();
    // A binary removed since setup recorded it: the PATH may still hold another.
    if (recorded && existsSync(recorded)) return recorded;
  } catch {}
  return "starbridge";
}

/** The mod's host aborts a call after 30 s; the loop is built around that limit. */
const CALL_MS = 30_000;

/** How long the CLI gets once stopped: it reports the prompt settled within 5 s. */
export const STOP_MS = 10_000;

/**
 * One HTTP call on the agent's unix socket, or on loopback TCP when the address is a port file.
 * Rejects when it cannot connect or takes too long.
 */
export async function socketFetch(socket: string, method: string, path: string, body?: unknown) {
  let target: { socketPath: string } | { host: string; port: number } = { socketPath: socket };
  let auth: Record<string, string> = {};
  let expect: string | undefined;
  if (isPortFile(socket)) {
    let t: ReturnType<typeof portTarget>;
    try {
      t = portTarget(readFileSync(socket, "utf8"));
    } catch {}
    // An agent that died left its port file: whoever holds the port now gets nothing (#570).
    if (!t || !processAlive(t.pid)) throw new Error(`no agent on ${socket}`);
    target = { host: "127.0.0.1", port: t.port };
    const signed = await signCall(t.token);
    auth = signed.headers;
    expect = signed.expect;
  }
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        ...target,
        path,
        method,
        headers: {
          ...auth,
          ...HEADERS,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        timeout: CALL_MS,
      },
      (res) => {
        if (expect !== undefined && res.headers[PROOF_HEADER] !== expect) {
          res.resume();
          return reject(new Error(`no agent on ${socket}: the port answers without its proof`));
        }
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

/** Whether process `pid` runs, as the CLI's `processAlive`: one of another user's still does. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs `argv`; never rejects, as the mod's `$.process.run`. */
export function runCommand(argv: string[], timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const [cmd, ...args] = argv;
    const shell = viaShell(cmd as string);
    if (!plain(cmd as string, args))
      return resolve({ exitCode: null, stdout: "", stderr: "an argument cmd.exe cannot carry" });
    const child = spawn(cmd as string, args, { stdio: ["ignore", "pipe", "pipe"], shell });
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
    const command = cli({ ...process.env, ...env });
    const shell = viaShell(command);
    if (!plain(command, args)) return resolve("");
    const child = spawn(command, ["hook", ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
      shell,
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    // The caller stops the CLI when the keyboard answers or it overran; one that ignores
    // SIGTERM is killed.
    let kill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      // Through a shell, `kill` would end only cmd.exe; Windows has no SIGTERM to catch anyway.
      if (shell && child.pid !== undefined)
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on(
          "error",
          () => {},
        );
      else child.kill("SIGTERM");
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
