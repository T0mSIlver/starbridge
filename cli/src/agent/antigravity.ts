/**
 * Antigravity's own prompts on the devices (#962): approvals and `ask_question`. A hook cannot
 * approve anything in Antigravity, but its language server takes the answer to a waiting step
 * from any client ("Answered from another device"). So the agent watches each server it has a
 * route to, which a `starbridge` command run in that Antigravity process registered: every
 * WATCH_MS, the running conversations' newest steps. A waiting one is posted to the devices by
 * the same `hook permission` and `hook question` the other agents run, and the first answer
 * wins: a device's goes to the server, and a keyboard answer ends the step, which stops the
 * hook as SIGTERM does, so the devices see it settled elsewhere.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type AgyRoute, lsCall } from "../antigravity";
import { permissionsEnabled } from "../permissions";
import { selfCommand } from "../setup/sys";
import { type Feature, HttpError, type Hub, pause } from "./server";

/** How often each server is read: how late a prompt reaches the devices at most. */
export const WATCH_MS = 1_000;
/** How many of a conversation's newest steps are read each time. */
const TAIL = 3;

interface Question {
  question?: string;
  options?: { id?: string; text?: string }[];
  isMultiSelect?: boolean;
}

/** A step, with what it waits for when it waits. */
interface Step {
  status?: string;
  requestedInteraction?: {
    permission?: { resource?: { action?: string; target?: string } };
    askQuestion?: { questions?: Question[] };
  };
}

interface Summary {
  status?: string;
  stepCount?: number;
  trajectoryId?: string;
  workspaces?: { workspaceFolderAbsoluteUri?: string }[];
}

/** Runs one of the CLI's hooks with `input` on stdin; resolves to what it printed. */
export type RunHook = (args: string[], input: unknown, signal: AbortSignal) => Promise<string>;

/** The hook as a child process of this binary; aborting `signal` sends it SIGTERM. */
export function spawnHook(env: Record<string, string | undefined>): RunHook {
  return (args, input, signal) =>
    new Promise((resolve) => {
      const [cmd, ...pre] = selfCommand(env);
      const child = spawn(cmd as string, [...pre, ...args], {
        stdio: ["pipe", "pipe", "ignore"],
        env: env as NodeJS.ProcessEnv,
      });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      const stop = () => child.kill("SIGTERM");
      signal.addEventListener("abort", stop, { once: true });
      child.on("close", () => {
        signal.removeEventListener("abort", stop);
        resolve(out);
      });
      child.on("error", () => resolve(""));
      child.stdin.end(JSON.stringify(input));
    });
}

/** The answer `hook permission` printed, in Claude Code's shape, as Antigravity's. */
export function permissionAnswer(
  out: string,
): { allow: boolean; userDenyInstruction?: string } | undefined {
  try {
    const d = (
      JSON.parse(out) as {
        hookSpecificOutput?: { decision?: { behavior?: string; message?: string } };
      }
    ).hookSpecificOutput?.decision;
    if (d?.behavior === "allow") return { allow: true };
    if (d?.behavior === "deny")
      return { allow: false, ...(d.message ? { userDenyInstruction: d.message } : {}) };
  } catch {}
  return undefined;
}

/** The labels `hook question` printed for each question, as Antigravity's responses. */
export function questionAnswer(out: string, questions: Question[]): unknown[] | undefined {
  let answers: unknown;
  try {
    answers = (JSON.parse(out) as { answers?: unknown }).answers;
  } catch {
    return undefined;
  }
  if (!Array.isArray(answers) || answers.length !== questions.length) return undefined;
  return questions.map((q, i) => {
    const labels =
      (answers as unknown[][])[i]?.filter((l): l is string => typeof l === "string") ?? [];
    const ids = labels.flatMap((l) => q.options?.find((o) => o.text === l)?.id ?? []);
    const typed = labels.filter((l) => !q.options?.some((o) => o.text === l));
    return {
      question: q.question,
      selectedOptionIds: ids,
      ...(typed.length > 0 ? { writeInResponse: typed.join(", ") } : {}),
    };
  });
}

export class Antigravity implements Feature {
  /** Each server's token, by address. */
  private servers = new Map<string, string>();
  /** The hooks started, by server, conversation and step, until the step stops waiting. */
  private open = new Map<string, AbortController>();
  /** Routes found dead, as address and token, never read again. */
  private dead = new Set<string>();

  constructor(
    private readonly hub: Hub,
    private readonly runHook: RunHook = spawnHook(hub.ctx.env),
  ) {}

  routes = [
    {
      method: "POST",
      path: "/v1/antigravity/routes",
      handle: async (req: { body: unknown }) => {
        const r = req.body as Partial<AgyRoute> | undefined;
        if (typeof r?.address !== "string" || typeof r.token !== "string")
          throw new HttpError(400, "bad-request", "post {address, token}");
        this.add(r as AgyRoute);
        return {};
      },
    },
  ];

  add(route: AgyRoute) {
    if (this.servers.get(route.address) === route.token) return;
    this.dead.delete(`${route.address} ${route.token}`);
    this.servers.set(route.address, route.token);
    this.hub.log(`watching Antigravity at ${route.address}`);
  }

  /** One read of every server: starts a hook for each new waiting step, stops ended ones. */
  async tick(): Promise<void> {
    // Routes the asked decisions carry, from before this agent started.
    for (const a of Object.values(this.hub.ctx.store.state().asked))
      if (
        a.antigravity &&
        !this.servers.has(a.antigravity.address) &&
        !this.dead.has(`${a.antigravity.address} ${a.antigravity.token}`)
      )
        this.add(a.antigravity);
    const waiting = new Set<string>();
    for (const [address, token] of this.servers) {
      const route = { address, token };
      let summaries: Record<string, Summary>;
      try {
        summaries =
          (
            await lsCall<{ trajectorySummaries?: Record<string, Summary> }>(
              route,
              "GetAllCascadeTrajectories",
              {},
            )
          ).trajectorySummaries ?? {};
      } catch (e) {
        // Gone with its process, or a new token: the next command registers it again.
        this.servers.delete(address);
        this.dead.add(`${address} ${token}`);
        this.hub.log(`stopped watching Antigravity at ${address}: ${(e as Error).message}`);
        continue;
      }
      for (const [conversation, s] of Object.entries(summaries)) {
        if (s.status !== "CASCADE_RUN_STATUS_RUNNING" || !s.trajectoryId) continue;
        const offset = Math.max(0, (s.stepCount ?? 0) - TAIL);
        let steps: Step[];
        try {
          steps =
            (
              await lsCall<{ steps?: Step[] }>(route, "GetCascadeTrajectorySteps", {
                cascadeId: conversation,
                stepOffset: offset,
              })
            ).steps ?? [];
        } catch {
          // Unread is not answered: its hooks stay, and no card is posted twice.
          for (const key of this.open.keys())
            if (key.startsWith(`${address} ${conversation} `)) waiting.add(key);
          continue;
        }
        steps.forEach((step, i) => {
          if (step.status !== "CORTEX_STEP_STATUS_WAITING" || !step.requestedInteraction) return;
          const key = `${address} ${conversation} ${s.trajectoryId} ${offset + i}`;
          waiting.add(key);
          if (!this.open.has(key))
            this.start(key, route, conversation, s, offset + i, step.requestedInteraction);
        });
      }
    }
    // A step no longer waiting was answered at the keyboard, or its turn was stopped.
    for (const [key, stop] of this.open)
      if (!waiting.has(key)) {
        stop.abort();
        this.open.delete(key);
      }
  }

  private start(
    key: string,
    route: AgyRoute,
    conversation: string,
    s: Summary,
    stepIndex: number,
    asks: NonNullable<Step["requestedInteraction"]>,
  ) {
    const uri = s.workspaces?.[0]?.workspaceFolderAbsoluteUri;
    let cwd = "";
    try {
      // A path from another platform, such as a drive-less one on Windows, names no folder here.
      if (uri?.startsWith("file://")) cwd = fileURLToPath(uri);
    } catch {}
    let hook: { args: string[]; input: unknown; answer: (out: string) => unknown } | undefined;
    if (asks.permission?.resource?.target !== undefined && permissionsEnabled(this.hub.ctx)) {
      const { action, target } = asks.permission.resource;
      // A command shows as one, so the devices offer it as they offer Claude Code's Bash.
      const command = action === "command";
      hook = {
        args: ["hook", "permission", "--agent", "antigravity"],
        input: {
          session_id: conversation,
          cwd,
          tool_name: command ? "Bash" : (action ?? "permission"),
          tool_input: command ? { command: target } : { path: target },
        },
        answer: (out) => {
          const a = permissionAnswer(out);
          return a && { permission: { ...a, scope: "PERMISSION_SCOPE_ONCE" } };
        },
      };
    } else if (asks.askQuestion?.questions?.length) {
      const questions = asks.askQuestion.questions;
      hook = {
        args: ["hook", "question", "--agent", "antigravity"],
        input: {
          session_id: conversation,
          cwd,
          questions: questions.map((q) => ({
            question: q.question ?? "",
            options: (q.options ?? []).map((o) => ({ label: o.text ?? "" })),
            multiple: q.isMultiSelect === true,
          })),
        },
        answer: (out) => {
          const responses = questionAnswer(out, questions);
          return responses && { askQuestion: { responses } };
        },
      };
    }
    if (!hook) return;
    const stop = new AbortController();
    this.open.set(key, stop);
    const h = hook;
    void (async () => {
      try {
        const out = await this.runHook(h.args, h.input, stop.signal);
        const interaction = stop.signal.aborted ? undefined : h.answer(out);
        if (interaction)
          await lsCall(route, "HandleCascadeUserInteraction", {
            cascadeId: conversation,
            interaction: { trajectoryId: s.trajectoryId, stepIndex, ...interaction },
          });
      } catch (e) {
        this.hub.log(`Antigravity prompt in ${conversation}: ${(e as Error).message}`);
      }
    })();
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (
        this.servers.size > 0 ||
        Object.values(this.hub.ctx.store.state().asked).some((a) => a.antigravity)
      )
        await this.tick().catch((e) => this.hub.log(`Antigravity: ${(e as Error).message}`));
      await pause(WATCH_MS, signal);
    }
    for (const stop of this.open.values()) stop.abort();
  }
}
