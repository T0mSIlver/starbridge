import { resolve } from "node:path";
import type { Agent, Decision, DecisionLink, SessionLink } from "@starbridge/protocol";
import {
  type AgyRoute,
  ANTIGRAVITY_CONVERSATION,
  agyRoute,
  antigravityTitle,
} from "../antigravity";
import { claudeSession, knownClaudeSession } from "../claude";
import { type CodexSession, codexAsker, codexSession, codexTitle } from "../codex";
import { type Ctx, machineKind } from "../context";
import { CURSOR_CONVERSATION } from "../cursor";
import { OPENCODE_ANSWERS, OPENCODE_SESSION, OPENCODE_TITLE } from "../opencode";
import { PI_ANSWERS, piSessionTitle } from "../pi";
import { projectName } from "../project";

/** What a question says and where it goes: the part of an ask a file or a flag may give. */
export interface AskContent {
  question?: string;
  context?: string;
  options?: string[];
  recommended?: string;
  /** Post it already `waiting`: the agent has nothing else to do. */
  waiting?: boolean;
  /** The coding agent asking; default: Claude Code, Codex, Pi or opencode when it runs the command. */
  agent?: Agent;
  project?: string;
  session?: string;
  sessionTitle?: string;
  sessionLinks?: SessionLink[];
  /** Image files, PNG or JPEG, with what each shows when known. */
  images?: (string | { path: string; alt?: string })[];
  /** Pages to open, such as a claude.ai artifact. */
  links?: (string | DecisionLink)[];
  /** The page the owner answers on instead of Starbridge; the decision then has no options. */
  answerIn?: string | DecisionLink;
}

/**
 * Where an answer is delivered and what kind of session asks: the asking command's environment
 * gives them (`resolveSource`) and sends them to the local agent, so a file an agent writes must
 * not choose them.
 */
export interface AskRoute {
  /** Where a Codex session runs: its `CODEX_HOME` and the `codex` that answers reach it with. */
  codex?: CodexSession;
  /** Where an interactive Antigravity conversation's language server takes its answer. */
  antigravity?: AgyRoute;
  /** A Pi or opencode session whose Starbridge extension or plugin submits answers into it. */
  extensionAnswers?: boolean;
  /** A `claude -p` session: the mod starts no loop there, so nothing submits answers. */
  headless?: boolean;
  /**
   * The Claude Code subagent that asks, from `STARBRIDGE_CLAUDE_AGENT`, which the mod sets for a
   * subagent's `starbridge ask` (#1702): the mod sends the answer to that subagent.
   */
  subagent?: string;
}

/** What only a hook of this process sets, posting without the agent. */
export interface AskHost {
  /** For a hook that waits for the answer itself (`hook question`): no session gets it. */
  held?: boolean;
  /** Asked for Claude Code's open `AskUserQuestion` picker in this session (#848). */
  picker?: string;
  /** Asked for the next-step box Claude desktop showed in this Claude Code session (#2118). */
  nextStep?: string;
  /**
   * When one of several questions from one tool call was asked: the call's time plus its index in
   * milliseconds, so every inbox lists them together in the call's order (#1079).
   */
  askedAt?: Date;
}

export type AskInput = AskContent & AskRoute & AskHost;

/**
 * The entry points that take an ask from outside this process, each taking only the fields it
 * names (`pickFields`), so a field added to `AskHost` or `AskRoute` is closed to them until one
 * lists it. `satisfies` checks each name is a field; `Complete` that the list leaves none out.
 */
export const ASK_CONTENT_FIELDS = [
  "question",
  "context",
  "options",
  "recommended",
  "waiting",
  "agent",
  "project",
  "session",
  "sessionTitle",
  "sessionLinks",
  "images",
  "links",
  "answerIn",
] as const satisfies readonly (keyof AskContent)[];
export const ASK_ROUTE_FIELDS = [
  "codex",
  "antigravity",
  "extensionAnswers",
  "headless",
  "subagent",
] as const satisfies readonly (keyof AskRoute)[];

type Complete<T, L extends readonly PropertyKey[]> = [Exclude<keyof T, L[number]>] extends [never]
  ? true
  : never;
export const _contentComplete: Complete<AskContent, typeof ASK_CONTENT_FIELDS> = true;
export const _routeComplete: Complete<AskRoute, typeof ASK_ROUTE_FIELDS> = true;

/** `json`'s fields among `fields`, as they are; nothing else. */
export function pickFields<K extends keyof AskInput>(
  json: unknown,
  fields: readonly K[],
): Pick<AskInput, K> {
  const from = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of fields) if (k in from) out[k] = from[k];
  return out as Pick<AskInput, K>;
}

/**
 * Fills in which session asks, from the asking process's environment and directory. Unless the
 * flags give them, the title and links come from Claude Code's record of that session, so an
 * agent never has to look them up. The CLI resolves this before it hands a decision to the
 * local agent, which runs elsewhere.
 */
export function resolveSource(
  input: AskInput,
  env: Ctx["env"],
  cwd: string,
): AskInput & { project: string; session: string; sessionLinks: SessionLink[] } {
  const agent = agentOf(input, env).agent;
  const session = input.session ?? ownSession(agent, env) ?? "";
  const codex = agent === "codex" ? (input.codex ?? codexSession(env)) : undefined;
  const agy = agent === "antigravity" ? (input.antigravity ?? agyRoute(env)) : undefined;
  const answersEnv = agent === "pi" ? PI_ANSWERS : agent === "opencode" ? OPENCODE_ANSWERS : "";
  const extensionAnswers =
    !!answersEnv && (input.extensionAnswers ?? (!!session && env[answersEnv] === session));
  const headless =
    agent === "claude-code" && (input.headless ?? env.CLAUDE_CODE_SESSION_ATTENDED === "0");
  const claude =
    session &&
    agent !== "codex" &&
    agent !== "pi" &&
    agent !== "opencode" &&
    agent !== "antigravity" &&
    agent !== "cursor" &&
    (input.sessionTitle === undefined || input.sessionLinks === undefined)
      ? claudeSession(env, session)
      : undefined;
  const title =
    input.sessionTitle ??
    (agent === "pi"
      ? piSessionTitle(env)
      : agent === "opencode"
        ? env[OPENCODE_TITLE]?.slice(0, 200) || undefined
        : agent === "antigravity" && session
          ? antigravityTitle(env, session)
          : agent === "codex"
            ? codexTitle(env, session)
            : undefined) ??
    claude?.title;
  const at = (path: string) => resolve(cwd, path);
  // Only for the session the subagent runs in: another session's mod knows no such agent.
  const subagent =
    agent === "claude-code" && !input.held && session && session === env.CLAUDE_CODE_SESSION_ID
      ? (input.subagent ?? subagentOf(env))
      : undefined;
  return {
    ...input,
    ...(agent ? { agent } : {}),
    ...(subagent ? { subagent } : {}),
    ...(codex ? { codex } : {}),
    ...(agy ? { antigravity: agy } : {}),
    ...(extensionAnswers ? { extensionAnswers } : {}),
    ...(headless ? { headless } : {}),
    project: input.project ?? projectName(cwd),
    session,
    ...(title !== undefined ? { sessionTitle: title } : {}),
    sessionLinks: input.sessionLinks ?? claude?.links ?? [],
    // Image paths are the asking directory's; the agent reads them from its own.
    ...(input.images
      ? {
          images: input.images.map((i) =>
            typeof i === "string" ? at(i) : { ...i, path: at(i.path) },
          ),
        }
      : {}),
  };
}

export function sourceFor(input: AskInput, ctx: Ctx, machine: string): Decision["source"] {
  const r = resolveSource(input, ctx.env, process.cwd());
  return {
    machine,
    ...machineKind(ctx),
    project: r.project,
    session: r.session,
    ...(r.sessionTitle ? { sessionTitle: r.sessionTitle } : {}),
    ...(r.sessionLinks.length > 0 ? { links: r.sessionLinks } : {}),
  };
}

/**
 * `--agent`, else the agent that runs this command: Claude Code sets CLAUDECODE=1, Codex gives
 * every command its session id in CODEX_THREAD_ID, Pi in PI_SESSION_ID, and the Starbridge
 * opencode plugin STARBRIDGE_OPENCODE_SESSION (clearing the others it inherited), Antigravity
 * its conversation's in ANTIGRAVITY_CONVERSATION_ID. An agent passes these on to the agents it
 * starts, so two can be set. Codex, Pi, opencode and Antigravity run commands without a
 * terminal, so a Claude Code they started runs as `claude -p` (CLAUDE_CODE_SESSION_ATTENDED=0);
 * otherwise the other agent was started from a Claude Code session (a `codex exec` review, a
 * script) and asks. Antigravity comes after Codex, Pi and opencode for the same reason: they are
 * the ones a session starts for a review, as `codex exec` or `opencode run`.
 * Cursor sets CURSOR_AGENT=1 and comes last, before Claude Code: its flag names no session.
 */
export function agentOf(input: AskInput, env: Ctx["env"]): { agent?: Agent } {
  if (input.agent !== undefined) return { agent: input.agent };
  const claude = env.CLAUDECODE === "1";
  if (claude && env.CLAUDE_CODE_SESSION_ATTENDED === "0") return { agent: "claude-code" };
  if (env.CODEX_THREAD_ID) return { agent: "codex" };
  if (env.PI_SESSION_ID) return { agent: "pi" };
  if (env[OPENCODE_SESSION]) return { agent: "opencode" };
  if (env[ANTIGRAVITY_CONVERSATION]) return { agent: "antigravity" };
  if (env.CURSOR_AGENT === "1") return { agent: "cursor" };
  return claude ? { agent: "claude-code" } : {};
}

/** Characters a Claude Code agent id or teammate address takes; the mod sets nothing else. */
const AGENT_ID = /^[A-Za-z0-9_.@-]{1,200}$/;

function subagentOf(env: Ctx["env"]): string | undefined {
  const id = env.STARBRIDGE_CLAUDE_AGENT;
  return id && AGENT_ID.test(id) ? id : undefined;
}

/** The id of the agent that asks: an agent started from another one's shell inherits its id too. */
function ownSession(agent: Agent | undefined, env: Ctx["env"]): string | undefined {
  return agent === "codex"
    ? codexAsker(env)
    : agent === "pi"
      ? env.PI_SESSION_ID
      : agent === "opencode"
        ? env[OPENCODE_SESSION]
        : agent === "antigravity"
          ? env[ANTIGRAVITY_CONVERSATION]
          : agent === "cursor"
            ? env[CURSOR_CONVERSATION]
            : env.CLAUDE_CODE_SESSION_ID;
}

/**
 * `ask`'s `--session`, held to the asker (#1748): in an agent's session it may name only a session
 * id the environment carries, the asker's own or, for a subagent or an agent started from another
 * one's shell, the parent's (#1702), since the answer goes into the session it names. Outside every
 * agent's session, as in a script, it names any. Another id is dropped, so the decision is asked as
 * the asker's session, and `warning` says so; for a Claude Code id this machine does not know, it
 * keeps the words of #1702's warning.
 */
export function bindSession(
  input: AskInput,
  env: Ctx["env"],
): { input: AskInput; warning?: string } {
  const named = input.session;
  const carried = [
    env.CLAUDE_CODE_SESSION_ID,
    env.CODEX_THREAD_ID,
    codexAsker(env),
    env.PI_SESSION_ID,
    env[OPENCODE_SESSION],
    env[ANTIGRAVITY_CONVERSATION],
    env[CURSOR_CONVERSATION],
  ].filter((id): id is string => !!id);
  if (named === undefined || carried.length === 0 || carried.includes(named)) return { input };
  const { session: _, ...rest } = input;
  const agent = agentOf(rest, env).agent;
  const own = ownSession(agent, env);
  const as = own ? `this session (${own})` : "no session";
  const why =
    agent === "claude-code" && !knownClaudeSession(env, named)
      ? "names no Claude Code session on this machine"
      : "is not this session, and an answer goes only to the session that asked";
  return { input: rest, warning: `starbridge: --session ${named} ${why}, so it asks as ${as}.` };
}
