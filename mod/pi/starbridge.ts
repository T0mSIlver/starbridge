/**
 * The Starbridge extension for the Pi coding agent: Pi's counterpart of the Claude Code plugin's
 * rule and of this mod. It adds the owner's rule (plugin/hooks/rule.md) to the system prompt, and
 * in an interactive or RPC session it runs the mod's answer loop (switch.ts: through the
 * machine's agent, else the CLI) and submits each answer as a user message. An idle session
 * starts a turn with it; a busy one runs it once the agent finishes (`deliverAs: "followUp"`).
 *
 * While the loop runs, the session's commands get its id in STARBRIDGE_PI_ANSWERS, so `starbridge ask`
 * says the answer comes back as a prompt. In `pi -p` it says to `starbridge wait` instead.
 *
 * With pi-permission-system installed, it also registers the `starbridge` link in its authorizer
 * chain, so permission prompts can go to the owner's devices (permissions.ts).
 *
 * Pi loads it from the repository's Pi package (package.json, `pi`), with jiti; the types below
 * are the part of Pi's `ExtensionAPI` it uses, so the package needs no dependency on Pi.
 */
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLoop, socketPath } from "../hooks/agent.ts";
import { permissionHook, runCommand, sleep, socketFetch } from "../hooks/node.ts";
import { configDir, Poller } from "../hooks/poller.ts";
import { Switch } from "../hooks/switch.ts";
import {
  type AskDetails,
  authorize,
  hookInput,
  keyboardOnly,
  LINK,
  ownAsk,
  permissionsService,
  type Verdict,
} from "./permissions.ts";

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
/** The longest an ask holds the "Answer here" dialogs after its own closed. */
const DECIDE_MS = 10 * 60_000;

const here = dirname(fileURLToPath(import.meta.url));

function rule(): string | undefined {
  try {
    return readFileSync(join(here, "..", "..", "plugin", "hooks", "rule.md"), "utf8").trim();
  } catch {
    return undefined;
  }
}

export default function starbridge(pi: PiApi) {
  const text = rule();
  let loop: Switch | undefined;
  /** The session's context, for the permission link, which runs outside any handler. */
  let current: Ctx | undefined;
  /** Disposers of the link, by the session it was registered for. */
  const links = new Map<string, () => void>();
  /** Aborted when the session ends, so prompts still on the devices are settled. */
  let ended = new AbortController();
  /** The "Answer here" dialogs, one at a time. */
  let dialogs: Promise<void> = Promise.resolve();
  /** Asks waiting for pi-permission-system's decision, by its request id. */
  const deciding = new Map<string, () => void>();

  /**
   * Resolves once pi-permission-system announces its decision on ask `id`, the session ends, or
   * DECIDE_MS passes, so a missed announcement cannot hold the dialogs forever.
   */
  const untilDecided = (id: string | undefined, end: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (!id || end.aborted) return resolve();
      const timer = setTimeout(done, DECIDE_MS);
      timer.unref();
      function done() {
        clearTimeout(timer);
        end.removeEventListener("abort", done);
        if (deciding.get(id as string) === done) deciding.delete(id as string);
        resolve();
      }
      deciding.set(id, done);
      end.addEventListener("abort", done);
    });

  pi.events.on("permissions:decision", (data) => {
    const id = (data as { requestId?: unknown } | undefined)?.requestId;
    if (typeof id === "string") deciding.get(id)?.();
  });

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
        if (ownAsk(details)) return Promise.resolve({ kind: "allow" });
        if (keyboardOnly(details)) {
          if (!ctx.hasUI) return Promise.resolve({ kind: "defer" });
          // The defer opens pi-permission-system's dialog, so it waits its turn among the
          // "Answer here" dialogs and holds it until the ask is decided.
          const decided = untilDecided(details.requestId, ended.signal);
          return new Promise<Verdict>((resolve) => {
            const turn = () => {
              resolve({ kind: "defer" });
              return decided;
            };
            dialogs = dialogs.then(turn, turn);
          });
        }
        const file = ctx.sessionManager.getSessionFile();
        const stdin = JSON.stringify(
          hookInput(details, ctx.sessionManager.getSessionId(), ctx.cwd),
        );
        return authorize(stdin, {
          hook: (text, signal) =>
            permissionHook("pi", text, signal, file ? { PI_SESSION_FILE: file } : {}),
          ...(ctx.hasUI
            ? {
                keyboard: (signal: AbortSignal) =>
                  new Promise<void>((resolve) => {
                    const what =
                      details.command ??
                      details.path ??
                      details.target ??
                      details.toolName ??
                      "a tool";
                    const decided = untilDecided(details.requestId, ended.signal);
                    // Pi strands a dialog that another opens over it, so asks take turns, and a
                    // turn lasts until pi-permission-system decided the ask: after "Answer here"
                    // its own dialog takes the screen.
                    const turn = async () => {
                      if (!signal.aborted) {
                        await ctx.ui.select(
                          `Permission Required: sent to your devices through Starbridge\n${what}`,
                          ["Answer here"],
                          { signal },
                        );
                        // Closed because a device answered or the session ended: the keyboard did nothing.
                        if (!signal.aborted) resolve();
                      }
                      await decided;
                    };
                    dialogs = dialogs.then(turn, turn);
                  }),
              }
            : {}),
          sleep,
          ended: ended.signal,
        });
      }),
    );
  });

  pi.on("session_start", (_e, ctx) => {
    current = ctx;
    ended = new AbortController();
    dialogs = Promise.resolve();
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
    env[ANSWERS_ENV] = ctx.sessionManager.getSessionId();
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
    ended.abort();
    for (const dispose of links.values()) dispose();
    links.clear();
    delete process.env[ANSWERS_ENV];
    if (e.reason === "quit") await ending?.end();
    else await ending?.stop();
  });
}
