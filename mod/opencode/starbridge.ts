/**
 * The Starbridge plugin for opencode: opencode's counterpart of the Claude Code plugin's rule and
 * of this mod. It adds the owner's rule (plugin/hooks/rule.md) to the system prompt, and for each
 * session that runs a command it runs the mod's answer loop (switch.ts: through the machine's
 * agent, else the CLI) and submits each answer with `promptAsync`. An idle session starts a turn
 * with it; a busy one takes it at the next step of its turn.
 *
 * After a restart, a session waiting for its answer runs no command, so the plugin also starts
 * the loop of each session of its directory that the CLI's state shows waiting. Two opencode
 * processes may show one session; the first to claim an answer submits it.
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
 * Each call of opencode's `question` tool goes to `starbridge hook question --agent opencode`,
 * which posts its questions to the devices, the labels as options. The terminal's dialog stays up
 * too, and the first answer wins: the CLI's is sent with opencode's question reply route, and the
 * terminal answering or dismissing it stops the CLI, which settles the questions on the devices.
 *
 * `starbridge setup` copies this file, the mod's hooks it imports and rule.md into opencode's
 * config folder with the repository's layout, and opencode loads it with Bun. The types below are
 * the part of opencode's plugin API it uses, so it needs no dependency on opencode.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLoop, socketPath } from "../hooks/agent.ts";
import {
  hookCommand,
  permissionHook,
  runCommand,
  sleep,
  socketFetch,
  verdictOf,
} from "../hooks/node.ts";
import { configDir, Poller } from "../hooks/poller.ts";
import { Switch } from "../hooks/switch.ts";

/** opencode's SDK client (v1), as plugins receive it. */
interface Client {
  session: {
    get(o: {
      path: { id: string };
    }): Promise<{ data?: { title?: string; parentID?: string; directory?: string } }>;
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
  /**
   * What opencode shows at the keyboard: `command` for `bash`; `filepath` and `diff` for `edit`,
   * which its edit, write and apply_patch tools ask, and apply_patch's `files` with their moves;
   * `command` and `directories` for an `external_directory` ask from its shell tool; the repeated
   * input of a `doom_loop`, and so on.
   */
  metadata?: Record<string, unknown>;
}

/** A `question.asked` event's properties: one call of the `question` tool. */
export interface QuestionAsked {
  id: string;
  sessionID: string;
  questions: {
    question: string;
    header?: string;
    options?: { label: string; description?: string }[];
    multiple?: boolean;
    custom?: boolean;
  }[];
}

type Event =
  | { type: "permission.asked"; properties: Asked }
  | { type: "question.asked"; properties: QuestionAsked }
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

/** How long a claim on a submitted answer is kept (`claim`), and a question resumed. */
const CLAIM_MS = 7 * 24 * 3600_000;

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

/** The answers `starbridge hook question` printed, one array of labels per question. */
export function answersOf(stdout: string, count: number): string[][] | undefined {
  try {
    const a = (JSON.parse(stdout) as { answers?: unknown }).answers;
    if (
      Array.isArray(a) &&
      a.length === count &&
      a.every((x) => Array.isArray(x) && x.every((l) => typeof l === "string"))
    )
      return a as string[][];
  } catch {}
  return undefined;
}

/**
 * The hook input `starbridge hook permission` reads, in Claude Code's shape. The devices show its
 * `tool_input` before Allow, so it carries what opencode's own dialog shows: an edit's diff and
 * where each file goes (#489), the command beside the directories it reaches, and any other
 * permission's metadata. The path comes first, which the CLI takes as the summary.
 */
export function hookInput(p: Asked, cwd: string) {
  const { command, filepath, diff, directories, files, ...rest } = p.metadata ?? {};
  const patterns = p.patterns ?? [];
  const path = patterns.join(", ");
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
  let tool_input: Record<string, unknown>;
  if (typeof diff === "string") {
    const moved = Array.isArray(files) ? files.map((f, i) => fileLabel(f, patterns[i])) : [];
    const file_path = moved.length > 0 && !moved.includes(undefined) ? moved.join(", ") : undefined;
    tool_input = { file_path: file_path ?? (typeof filepath === "string" ? filepath : path), diff };
  } else if (typeof command === "string" && p.permission === "external_directory")
    tool_input = { path: strings(directories).join(", ") || path, command };
  else if (typeof command === "string") tool_input = { command };
  else
    tool_input = {
      // An MCP tool asks for `*`, which says nothing; its name is the permission.
      ...(path && path !== "*" ? { path } : {}),
      ...(typeof filepath === "string" ? { file_path: filepath } : {}),
      ...rest,
    };
  return { session_id: p.sessionID, cwd, tool_name: p.permission, tool_input };
}

/** One file of an apply_patch: its path, where a move takes it, or that it goes. */
function fileLabel(f: unknown, from: string | undefined): string | undefined {
  const { relativePath, type, movePath } = (f ?? {}) as Record<string, unknown>;
  if (typeof relativePath !== "string") return undefined;
  // A move's relativePath is where it goes; `patterns` hold where it comes from.
  if (typeof movePath === "string" && from !== undefined && from !== relativePath)
    return `${from} → ${relativePath}`;
  return type === "delete" ? `${relativePath} (deleted)` : relativePath;
}

/**
 * The sessions in the CLI's state told their answer comes back as a prompt, with a question
 * asked in the last `CLAIM_MS` still open or an answer not yet delivered: after a restart they run
 * no command that would start their loop. A session told to `wait` (`opencode run`) is left to it.
 */
export function waitingSessions(state: unknown, now: number): string[] {
  const st = state as {
    asked?: Record<
      string,
      {
        session?: string;
        askedAt?: string;
        extensionAnswers?: boolean;
        settled?: boolean;
        answerIn?: boolean;
      }
    >;
    answers?: Record<string, { seen?: boolean }>;
  };
  const ids = new Set<string>();
  for (const [id, a] of Object.entries(st?.asked ?? {})) {
    if (!a.session || !a.extensionAnswers || a.settled || a.answerIn) continue;
    if (st.answers?.[id]?.seen || !(now - Date.parse(a.askedAt ?? "") < CLAIM_MS)) continue;
    ids.add(a.session);
  }
  return [...ids];
}

/**
 * Claims answer `line` for session `id`, so that of two opencode processes showing the same
 * session only one submits it. False when the other already did.
 */
export async function claim(dir: string, id: string, line: string): Promise<boolean> {
  try {
    await mkdir(join(dir, "opencode-claims"), { recursive: true });
    await writeFile(claimFile(dir, id, line), "", { flag: "wx" });
    return true;
  } catch (e) {
    // Unwritable: submitting twice beats never.
    return (e as { code?: string }).code !== "EEXIST";
  }
}

const claimFile = (dir: string, id: string, line: string) =>
  join(
    dir,
    "opencode-claims",
    createHash("sha256").update(`${id}\n${line}`).digest("hex").slice(0, 32),
  );

const unclaim = (dir: string, id: string, line: string) =>
  rm(claimFile(dir, id, line), { force: true }).catch(() => {});

/** Drops claims older than `CLAIM_MS`. */
async function pruneClaims(dir: string, now: number) {
  const claims = join(dir, "opencode-claims");
  for (const f of await readdir(claims).catch(() => [])) {
    const m = (await stat(join(claims, f)).catch(() => undefined))?.mtimeMs;
    if (m !== undefined && now - m > CLAIM_MS) await rm(join(claims, f), { force: true });
  }
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
  /** Questions on the devices, by request id, with their session; aborting one stops its CLI. */
  const questions = new Map<string, { session: string; stop: AbortController }>();

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
        if (!(await claim(dir, id, line))) return;
        for (let i = 0; i < 4; i++) {
          const r = await client.session
            .promptAsync({ path: { id }, body: { parts: [{ type: "text", text: line }] } })
            .catch((e: unknown) => ({ error: e }));
          if (!r.error) return;
          await sleep(5_000 * 2 ** i);
        }
        // Another process showing the session may still submit it.
        await unclaim(dir, id, line);
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

  const question = async (q: QuestionAsked) => {
    const stop = new AbortController();
    questions.set(q.id, { session: q.sessionID, stop });
    const name = (await info(q.sessionID))?.title;
    const out = await hookCommand(
      ["question", "--agent", "opencode"],
      JSON.stringify({ session_id: q.sessionID, cwd: directory, questions: q.questions }),
      stop.signal,
      name ? { [TITLE_ENV]: name } : {},
    );
    // Deleted on the way out, so the `question.replied` this reply causes stops nothing.
    questions.delete(q.id);
    const answers = stop.signal.aborted ? undefined : answersOf(out, q.questions.length);
    if (!answers) return;
    // Refused: the terminal answered first, and the CLI settled nothing it could not tell.
    await client._client
      .post({
        url: "/question/{requestID}/reply",
        path: { requestID: q.id },
        body: { answers },
        headers: { "Content-Type": "application/json" },
      })
      .catch(() => {});
  };

  // Sessions of this directory waiting since before opencode started.
  if (answers)
    void (async () => {
      await pruneClaims(dir, Date.now());
      const state = await readFile(join(dir, "state.json"), "utf8").catch(() => "{}");
      for (const id of waitingSessions(JSON.parse(state), Date.now())) {
        // Worktrees of one repository share a project: the session's own directory decides.
        const s = await info(id);
        if (s && !s.parentID && s.directory === directory) loop(id);
      }
    })().catch(() => {});

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
      else if (event.type === "question.asked") void question(event.properties as QuestionAsked);
      else if (event.type === "question.replied" || event.type === "question.rejected")
        // Answered or dismissed at the terminal: the CLI settles the questions on the devices.
        questions.get((event.properties as { requestID: string }).requestID)?.stop.abort();
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
        for (const q of questions.values()) if (q.session === session) q.stop.abort();
      } else if (event.type === "session.deleted") {
        const id = (event.properties as { info: { id: string } }).info.id;
        for (const q of questions.values()) if (q.session === id) q.stop.abort();
        void loops.get(id)?.end();
        loops.delete(id);
      }
    },
    dispose: async () => {
      for (const a of asks.values()) a.stop.abort();
      for (const q of questions.values()) q.stop.abort();
      const ending = [...loops.values()];
      loops.clear();
      await Promise.all(ending.map((l) => l.end()));
    },
  };
}

export default { id: "starbridge", server };
