/**
 * The Starbridge extension for the Pi coding agent: Pi's counterpart of the Claude Code plugin's
 * rule and of this mod. It adds the owner's rule (plugin/hooks/rule.md) to the system prompt, and
 * in an interactive or RPC session it runs the mod's answer loop (switch.ts: through the
 * machine's agent, else the CLI) and submits each answer as a user message. An idle session
 * starts a turn with it; a busy one runs it once the agent finishes (`deliverAs: "followUp"`).
 *
 * While the loop runs, the session's commands get STARBRIDGE_PI_ANSWERS=1, so `starbridge ask`
 * says the answer comes back as a prompt. In `pi -p` it says to `starbridge wait` instead.
 *
 * With pi-permission-system installed, it also registers the `starbridge` link in its authorizer
 * chain, so permission prompts can go to the owner's devices (permissions.ts).
 *
 * Pi loads it from the repository's Pi package (package.json, `pi`), with jiti; the types below
 * are the part of Pi's `ExtensionAPI` it uses, so the package needs no dependency on Pi.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLoop, HEADERS, socketPath } from "../hooks/agent.ts";
import { configDir, Poller } from "../hooks/poller.ts";
import { Switch } from "../hooks/switch.ts";
import { type AskDetails, authorize, hookInput, LINK, permissionsService } from "./permissions.ts";

interface Ctx {
  hasUI: boolean;
  cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  ui: {
    setStatus(key: string, text: string | undefined): void;
    select(
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal },
    ): Promise<string | undefined>;
  };
}

interface PiApi {
  on(event: "session_start", handler: (e: unknown, ctx: Ctx) => unknown): void;
  on(
    event: "session_shutdown",
    handler: (e: { reason: "quit" | "reload" | "new" | "resume" | "fork" }, ctx: Ctx) => unknown,
  ): void;
  on(
    event: "before_agent_start",
    handler: (e: { systemPrompt: string }, ctx: Ctx) => { systemPrompt?: string } | undefined,
  ): void;
  sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  events: { on(channel: string, handler: (data: unknown) => void): () => void };
}

/** Set for the session's commands while answers come back into it (cli/src/pi.ts). */
const ANSWERS_ENV = "STARBRIDGE_PI_ANSWERS";
/** The mod's host aborts a call after 30 s; the loop is built around that limit. */
const CALL_MS = 30_000;

const here = dirname(fileURLToPath(import.meta.url));

function rule(): string | undefined {
  try {
    return readFileSync(join(here, "..", "..", "plugin", "hooks", "rule.md"), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** One HTTP call on the agent's unix socket. Rejects when it cannot connect or takes too long. */
function socketFetch(socket: string, method: string, path: string, body?: unknown) {
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
function runCommand(argv: string[], timeoutMs: number) {
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
 * `starbridge hook permission --agent pi` with `stdin`; resolves to what it printed. An abort
 * sends SIGTERM, which the CLI takes as the keyboard answering.
 */
function permissionHook(stdin: string, signal: AbortSignal, sessionFile: string | undefined) {
  return new Promise<string>((resolve) => {
    const child = spawn("starbridge", ["hook", "permission", "--agent", "pi"], {
      env: { ...process.env, ...(sessionFile ? { PI_SESSION_FILE: sessionFile } : {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop);
    child.on("error", () => resolve(""));
    child.on("close", () => {
      signal.removeEventListener("abort", stop);
      resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/** A sleep that never keeps Pi from exiting. */
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref();
  });

export default function starbridge(pi: PiApi) {
  const text = rule();
  let loop: Switch | undefined;
  /** The session's context, for the permission link, which runs outside any handler. */
  let current: Ctx | undefined;
  /** Disposers of the link, by the session it was registered for. */
  const links = new Map<string, () => void>();

  pi.on("before_agent_start", (e) =>
    text ? { systemPrompt: `${e.systemPrompt}\n\n${text}` } : undefined,
  );

  // pi-permission-system announces its service for each session, possibly more than once.
  pi.events.on("permissions:ready", (data) => {
    const id = (data as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof id !== "string" || links.has(id)) return;
    const service = permissionsService(id);
    if (!service) return;
    links.set(
      id,
      service.registerAuthorizer(LINK, (details: AskDetails) => {
        const ctx = current;
        if (!ctx) return Promise.resolve({ kind: "defer" });
        const file = ctx.sessionManager.getSessionFile();
        const stdin = JSON.stringify(
          hookInput(details, ctx.sessionManager.getSessionId(), ctx.cwd),
        );
        return authorize(stdin, {
          hook: (text, signal) => permissionHook(text, signal, file),
          ...(ctx.hasUI
            ? {
                keyboard: async (signal: AbortSignal) => {
                  const what = details.command ?? details.path ?? details.toolName ?? "a tool";
                  await ctx.ui.select(
                    `Permission Required: sent to your devices through Starbridge\n${what}`,
                    ["Answer here"],
                    { signal },
                  );
                  // Closed because a device answered: the keyboard did nothing.
                  if (signal.aborted) await new Promise(() => {});
                },
              }
            : {}),
          sleep,
        });
      }),
    );
  });

  pi.on("session_start", (_e, ctx) => {
    current = ctx;
    void loop?.stop();
    loop = undefined;
    // `pi -p` and `--mode json` end after one prompt: nothing would be there to submit into.
    if (!ctx.hasUI) return;
    const env: Record<string, string | undefined> = process.env;
    const dir = configDir(env);
    const socket = socketPath(env);
    const fetch = (method: string, path: string, body?: unknown) =>
      socketFetch(socket, method, path, body);
    const sessionId = async () => ctx.sessionManager.getSessionId();
    const now = async () => Date.now();
    const submit = (line: string) => pi.sendUserMessage(line, { deliverAs: "followUp" });
    const status = (s: string | undefined) => ctx.ui.setStatus("starbridge", s);
    const log = (_s: string) => {};
    env[ANSWERS_ENV] = "1";
    loop = new Switch({
      agentUp: async () =>
        !env.STARBRIDGE_NO_AGENT && (await fetch("GET", "/v1/status")).status < 300,
      agent: (unconfirmed) =>
        new AgentLoop(
          { sessionId, cwd: async () => ctx.cwd, fetch, now, sleep, submit, status, log },
          unconfirmed,
        ),
      poller: (unconfirmed) =>
        new Poller(
          {
            sessionId,
            run: runCommand,
            read: (path) => readFile(path, "utf8"),
            write: (path, t) => writeFile(path, t),
            mtime: async (path) => (await stat(path).catch(() => undefined))?.mtimeMs,
            now,
            sleep,
            submit,
            status,
            log,
          },
          dir,
          undefined,
          undefined,
          unconfirmed,
        ),
      sleep,
      clearStatus: () => status(undefined),
      log,
    });
  });

  // A new, resumed or forked session gets its own `session_start` and loop; only quitting tells
  // the agent the session ended.
  pi.on("session_shutdown", async (e) => {
    const ending = loop;
    loop = undefined;
    current = undefined;
    for (const dispose of links.values()) dispose();
    links.clear();
    delete process.env[ANSWERS_ENV];
    if (e.reason === "quit") await ending?.end();
    else await ending?.stop();
  });
}
