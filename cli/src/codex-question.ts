/**
 * Codex's `request_user_input` on the devices (#951), raced with its picker in the TUI as Claude
 * Code's `AskUserQuestion` is (#848). The plugin's `PreToolUse` hook on the tool runs `hook
 * question --agent codex`, which starts the race in a detached process and returns at once: a
 * hook that held would hold the picker back. The race joins the thread on the Codex daemon,
 * which sends the picker's request to every client of the thread, posts each question as a
 * decision, already waiting, and answers the request once every question has a device's
 * answer. The first answer wins: when the daemon says the request was resolved first, at the
 * keyboard, the decisions are settled `elsewhere`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Answer } from "@starbridge/protocol";
import { CodexApp, type CodexMessage, codexControlSocket } from "./codex-app";
import { type Ctx, session, UsageError } from "./context";
import {
  type AskInput,
  EXIT_SNOOZED,
  postDecision,
  resolveSource,
  settle,
  wait,
} from "./decisions";
import { questionInput } from "./hook";
import { selfCommand } from "./setup/sys";

/** What Codex 0.160 gives a `PreToolUse` hook (fields Starbridge reads). */
interface PreToolUseInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

/** One question of the daemon's `item/tool/requestUserInput`. */
interface CodexQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
}

/**
 * How long the race waits for the picker once the hook ran: the tool asks at once, or not at
 * all, as in Default mode, which refuses it.
 */
const ASK_MS = 15_000;
/** How long a question waits for the devices: the picker waits for its answer with no limit. */
const HOLD_MS = 24 * 3600_000;

function codexHome(env: Ctx["env"]): string | undefined {
  return env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : undefined);
}

function parse(
  stdin: string,
): Required<Pick<PreToolUseInput, "session_id" | "tool_use_id">> & PreToolUseInput {
  const hook = JSON.parse(stdin) as PreToolUseInput;
  if (
    hook?.tool_name !== "request_user_input" ||
    typeof hook.session_id !== "string" ||
    typeof hook.tool_use_id !== "string"
  )
    throw new UsageError("the hook input is not a request_user_input call");
  return hook as ReturnType<typeof parse>;
}

/** Starts this CLI, detached, to run the race with `stdin` as its input. */
function spawnRace(ctx: Ctx, stdin: string) {
  const [file, ...args] = selfCommand(ctx.env) as [string, ...string[]];
  const child = spawn(file, [...args, "hook", "question", "--agent", "codex", "--race"], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    env: process.env,
  });
  child.on("error", () => {});
  child.stdin?.end(stdin);
  child.unref();
}

/**
 * `starbridge hook question --agent codex`, the `PreToolUse` input on stdin: starts the race and
 * prints nothing, so the picker opens. Without the daemon (a TUI that runs its own app server,
 * `codex exec`) or a pairing there is nothing to race, and the question stays at the keyboard.
 * With `race`, it is the race.
 */
export async function hookCodexQuestion(
  ctx: Ctx,
  stdin: string,
  race: boolean,
  start: typeof spawnRace = spawnRace,
): Promise<number> {
  try {
    const hook = parse(stdin);
    const home = codexHome(ctx.env);
    if (!home || !existsSync(codexControlSocket(home))) return 0;
    session(ctx);
    if (!race) {
      start(ctx, stdin);
      return 0;
    }
    await raceCodex(ctx, hook, home);
  } catch (e) {
    ctx.err(`starbridge: question not sent: ${(e as Error).message}`);
  }
  return 0;
}

/** What Codex takes for one question: the label tapped, or a typed reply as the TUI's note. */
export function codexAnswer(a: Answer): string[] {
  return a.choice !== undefined ? [a.choice] : [`user_note: ${a.text ?? ""}`];
}

async function raceCodex(ctx: Ctx, hook: ReturnType<typeof parse>, home: string) {
  const thread = hook.session_id;
  const call = hook.tool_use_id;
  const over = new AbortController();
  let asked: ((m: CodexMessage) => void) | undefined;
  let requestId: number | string | undefined;
  const app = await CodexApp.connect(home, (m) => {
    const p = m.params ?? {};
    if (m.method === "item/tool/requestUserInput" && p.threadId === thread && p.itemId === call)
      asked?.(m);
    // Answered at the keyboard, or the turn ended or was interrupted: the picker is gone.
    else if (
      (m.method === "serverRequest/resolved" &&
        p.threadId === thread &&
        p.requestId === requestId) ||
      (m.method === "turn/completed" && p.threadId === thread) ||
      (m.method === "item/completed" &&
        p.threadId === thread &&
        (p.item as { id?: unknown } | undefined)?.id === call)
    )
      over.abort();
  });
  void app.done.then(() => over.abort());
  try {
    // A thread the daemon has not loaded is not the TUI's: resuming it would load it there.
    const loaded = (await app.request("thread/loaded/list", {})) as { data?: unknown };
    if (!Array.isArray(loaded?.data) || !loaded.data.includes(thread)) return;
    const request = new Promise<CodexMessage | undefined>((resolve) => {
      asked = resolve;
      setTimeout(() => resolve(undefined), ASK_MS).unref();
      over.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    // The daemon replays a request already pending to a client that subscribes after it.
    await app.request("thread/resume", { threadId: thread, excludeTurns: true });
    const m = await request;
    if (!m || m.id === undefined) return;
    requestId = m.id;
    const questions = (m.params?.questions ?? []) as CodexQuestion[];
    // A secret is typed at the keyboard only.
    if (questions.length === 0 || questions.some((q) => q.isSecret)) return;
    const answers = await ask(ctx, hook, questions, over.signal);
    if (answers && !over.signal.aborted)
      app.respond(requestId, {
        answers: Object.fromEntries(questions.map((q, i) => [q.id, { answers: answers[i] }])),
      });
  } finally {
    await app.request("thread/unsubscribe", { threadId: thread }).catch(() => {});
    app.close();
  }
}

/**
 * Posts each question as a decision, already waiting and held from the session's answer loop,
 * and returns their answers once all have one; undefined when `signal` ended the race first, a
 * question could not be asked, or the hold ran out, settling the open ones.
 */
async function ask(
  ctx: Ctx,
  hook: ReturnType<typeof parse>,
  questions: CodexQuestion[],
  signal: AbortSignal,
): Promise<string[][] | undefined> {
  const s = session(ctx);
  const thread = hook.session_id;
  const cwd = typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd();
  const failed = new AbortController();
  const stop = AbortSignal.any([signal, failed.signal, AbortSignal.timeout(HOLD_MS)]);
  const ids: (string | undefined)[] = [];
  const results = await Promise.allSettled(
    questions.map(async (q, i) => {
      const sub: Ctx = { ...ctx, signal: stop, err: () => {} };
      const input: AskInput = {
        ...questionInput({ question: q.question, options: q.options ?? [] }),
        agent: "codex",
        session: thread,
        project: basename(cwd),
        held: true,
        picker: thread,
        waiting: true,
      };
      try {
        ({ id: ids[i] } = await postDecision(sub, s, resolveSource(input, ctx.env, cwd)));
      } catch (e) {
        failed.abort();
        throw e;
      }
      // A snooze puts it off on the devices; the picker still waits for an answer.
      while (true) {
        const lines: string[] = [];
        const code = await wait(
          { ...sub, out: (l) => lines.push(l) },
          { id: ids[i] as string, json: true, "no-mark": true },
          s,
        );
        if (code === 0 && lines[0]) return codexAnswer(JSON.parse(lines[0]) as Answer);
        if (code !== EXIT_SNOOZED) return undefined;
      }
    }),
  );
  const picked = results.map((r) => (r.status === "fulfilled" ? r.value : undefined));
  const error = results.find((r) => r.status === "rejected");
  if (error && !stop.aborted)
    ctx.err(`starbridge: question not sent: ${(error.reason as Error).message}`);
  if (picked.every((p) => p !== undefined) && !stop.aborted) return picked as string[][];
  // Answered at the keyboard or the turn ended: moot on the devices. Otherwise none of the
  // answers can reach the picker any more.
  const outcome = signal.aborted ? "elsewhere" : "withdrawn";
  await Promise.all(
    ids.map((id) =>
      id
        ? settle({ ...ctx, signal: undefined }, { id, outcome }).catch((e) =>
            ctx.err(`starbridge: could not settle ${id}: ${(e as Error).message}`),
          )
        : undefined,
    ),
  );
  return undefined;
}
