/**
 * The Starbridge plugin for opencode: opencode's counterpart of the Claude Code plugin's rule and
 * of this mod. It adds the owner's rule (plugin/hooks/rule.md) to the system prompt, and for each
 * session that runs a command it runs the mod's answer loop (switch.ts: through the machine's
 * agent, else the CLI) and submits each answer with `promptAsync`. An idle session starts a turn
 * with it; a busy one takes it at the next step of its turn.
 *
 * opencode gives commands no session id, so the plugin sets STARBRIDGE_OPENCODE_SESSION and
 * STARBRIDGE_OPENCODE_TITLE for them (cli/src/opencode.ts), and STARBRIDGE_OPENCODE_ANSWERS while
 * answers come back, which they cannot in `opencode run`: it exits once the session is idle.
 *
 * Each permission prompt goes to `starbridge hook permission --agent opencode`, which does
 * nothing while `starbridge config permissions` is off. opencode's dialog stays up meanwhile, and
 * the first answer wins: the CLI's is sent with opencode's reply route, and a reply from the
 * keyboard stops the CLI, which settles the prompt on the devices.
 *
 * `starbridge setup` copies this file, the mod's hooks it imports and rule.md into opencode's
 * config folder with the repository's layout, and opencode loads it with Bun. The types below are
 * the part of opencode's plugin API it uses, so it needs no dependency on opencode.
 */
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLoop, socketPath } from "../hooks/agent.ts";
import { permissionHook, runCommand, sleep, socketFetch, verdictOf } from "../hooks/node.ts";
import { configDir, Poller } from "../hooks/poller.ts";
import { Switch } from "../hooks/switch.ts";

/** opencode's SDK client (v1), as plugins receive it. */
interface Client {
  session: {
    get(o: { path: { id: string } }): Promise<{ data?: { title?: string; parentID?: string } }>;
    promptAsync(o: {
      path: { id: string };
      body: { parts: { type: "text"; text: string }[] };
    }): Promise<{ error?: unknown }>;
  };
  /** The generated client underneath, for the reply route the v1 classes lack. */
  _client: {
    post(o: {
      url: string;
      path: Record<string, string>;
      body: unknown;
      headers: Record<string, string>;
    }): Promise<{ error?: unknown }>;
  };
}

interface Input {
  client: Client;
  directory: string;
}

/** A `permission.asked` event's properties. */
export interface Asked {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: { command?: unknown };
}

type Event =
  | { type: "permission.asked"; properties: Asked }
  | { type: "permission.replied"; properties: { requestID: string; reply: string } }
  | { type: "session.deleted"; properties: { info: { id: string } } }
  | { type: string; properties: unknown };

/** The variables the CLI reads (cli/src/opencode.ts). */
const SESSION_ENV = "STARBRIDGE_OPENCODE_SESSION";
const TITLE_ENV = "STARBRIDGE_OPENCODE_TITLE";
const ANSWERS_ENV = "STARBRIDGE_OPENCODE_ANSWERS";
/** What Claude Code, Codex and Pi give their commands (cli/src/decisions.ts, `agentOf`). */
const INHERITED = ["CLAUDECODE", "CODEX_THREAD_ID", "PI_SESSION_ID"];

/**
 * How long a prompt waits for the CLI at most: its own wait (570 s) plus slack. A CLI stuck on
 * a stalled server must never hold the prompt.
 */
const HOOK_MS = 600_000;

const here = dirname(fileURLToPath(import.meta.url));

function rule(): string | undefined {
  try {
    return readFileSync(join(here, "..", "..", "plugin", "hooks", "rule.md"), "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Whether this process is `opencode run`, which exits once its session is idle. The TUI's
 * plugins run in a worker whose argv holds no command, and a flag's value may come before `run`.
 */
export function isRun(argv: string[]): boolean {
  return argv.slice(2).includes("run");
}

/** The hook input `starbridge hook permission` reads, in Claude Code's shape. */
export function hookInput(p: Asked, cwd: string) {
  const command = p.metadata?.command;
  return {
    session_id: p.sessionID,
    cwd,
    tool_name: p.permission,
    tool_input: typeof command === "string" ? { command } : { path: (p.patterns ?? []).join(", ") },
  };
}

async function server({ client, directory }: Input) {
  const text = rule();
  const answers = !isRun(process.argv);
  const env: Record<string, string | undefined> = process.env;
  const dir = configDir(env);
  const socket = socketPath(env);
  const fetch = (method: string, path: string, body?: unknown) =>
    socketFetch(socket, method, path, body);
  const now = async () => Date.now();
  const log = (_s: string) => {};
  const status = (_s: string | undefined) => {};
  /** The answer loop of each session that ran a command. */
  const loops = new Map<string, Switch>();
  /** Prompts on the devices, by request id, with their session; aborting one stops its CLI. */
  const asks = new Map<string, { session: string; stop: AbortController }>();
  /** The reply this plugin sent to each prompt, to tell its `permission.replied` apart. */
  const replied = new Map<string, string>();

  const info = async (id: string) => {
    try {
      return (await client.session.get({ path: { id } })).data;
    } catch {
      return undefined;
    }
  };

  const loop = (id: string) => {
    if (!answers || loops.has(id)) return;
    const sessionId = async () => id;
    // The loop confirms an answer once submitted, so a refused submit is tried again a few
    // times; the answer also stays in the CLI's state, where `starbridge wait` finds it.
    const submit = (line: string) => {
      void (async () => {
        for (let i = 0; i < 4; i++) {
          const r = await client.session
            .promptAsync({ path: { id }, body: { parts: [{ type: "text", text: line }] } })
            .catch((e: unknown) => ({ error: e }));
          if (!r.error) return;
          await sleep(5_000 * 2 ** i);
        }
      })();
    };
    loops.set(
      id,
      new Switch({
        agentUp: async () =>
          !env.STARBRIDGE_NO_AGENT && (await fetch("GET", "/v1/status")).status < 300,
        agent: (unconfirmed) =>
          new AgentLoop(
            { sessionId, cwd: async () => directory, fetch, now, sleep, submit, status, log },
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
        clearStatus: () => {},
        log,
      }),
    );
  };

  const reply = async (requestID: string, body: { reply: "once" | "reject"; message?: string }) => {
    replied.set(requestID, body.reply);
    const r = await client._client
      .post({
        url: "/permission/{requestID}/reply",
        path: { requestID },
        body,
        headers: { "Content-Type": "application/json" },
      })
      .catch((e: unknown) => ({ error: e }));
    // Refused: the prompt was already answered, and its event came or will not come.
    if (r.error) replied.delete(requestID);
  };

  const ask = async (p: Asked) => {
    const stop = new AbortController();
    asks.set(p.id, { session: p.sessionID, stop });
    const name = (await info(p.sessionID))?.title;
    const overran = setTimeout(() => stop.abort(), HOOK_MS);
    overran.unref();
    const out = await permissionHook(
      "opencode",
      JSON.stringify(hookInput(p, directory)),
      stop.signal,
      name ? { [TITLE_ENV]: name } : {},
    );
    clearTimeout(overran);
    asks.delete(p.id);
    if (stop.signal.aborted) return;
    const v = verdictOf(out);
    if (v.kind === "defer") return;
    await reply(
      p.id,
      v.kind === "allow"
        ? { reply: "once" }
        : { reply: "reject", ...(v.reason ? { message: v.reason } : {}) },
    );
  };

  return {
    "shell.env": async (input: { sessionID?: string }, output: { env: Record<string, string> }) => {
      const id = input.sessionID;
      // The owner's own terminal (PTY) has no session.
      if (!id) return;
      output.env[SESSION_ENV] = id;
      // An opencode started from Claude Code, Codex or Pi inherits their markers, which `ask`
      // would take for the agent asking.
      for (const name of INHERITED) output.env[name] = "";
      const session = await info(id);
      if (session?.title) output.env[TITLE_ENV] = session.title;
      // A subagent's session ends with its task, so an answer submitted there reaches nobody:
      // its agent waits for the answer instead.
      if (!answers || session?.parentID) return;
      output.env[ANSWERS_ENV] = id;
      loop(id);
    },
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      if (text) output.system.push(text);
    },
    event: async ({ event }: { event: Event }) => {
      if (event.type === "permission.asked") void ask(event.properties as Asked);
      else if (event.type === "permission.replied") {
        const { requestID: id, reply: how } = event.properties as {
          requestID: string;
          reply: string;
        };
        const sent = replied.get(id);
        replied.delete(id);
        // Answered at the keyboard, or by opencode for a sibling prompt: the CLI settles the
        // prompt on the devices.
        if (sent !== how) asks.get(id)?.stop.abort();
      } else if (event.type === "session.idle") {
        // The turn ended (Esc, an error) with prompts still out: they are moot.
        const session = (event.properties as { sessionID: string }).sessionID;
        for (const a of asks.values()) if (a.session === session) a.stop.abort();
      } else if (event.type === "session.deleted") {
        const id = (event.properties as { info: { id: string } }).info.id;
        void loops.get(id)?.end();
        loops.delete(id);
      }
    },
    dispose: async () => {
      for (const a of asks.values()) a.stop.abort();
      const ending = [...loops.values()];
      loops.clear();
      await Promise.all(ending.map((l) => l.end()));
    },
  };
}

export default { id: "starbridge", server };
