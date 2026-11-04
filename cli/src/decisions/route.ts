/**
 * The one route an answer takes into the session that asked, picked once when it is asked
 * (#2284). `ask` promises a prompt exactly when there is a route, and only that route delivers:
 * when the promise and the delivery were worked out in two places, they disagreed (#321, #863,
 * #2100, #2101).
 */
import type { AgyRoute } from "../antigravity";
import type { CodexSession } from "../codex";
import type { State } from "../config";
import type { T3Route } from "../t3";
import type { AskInput } from "./source";

/**
 * - `mod`: Claude Code's mod, or Cursor's hooks, take it from the agent's session events.
 * - `turn`: Claude Code's mod in a `claude -p` run, which ends with its turn (#2258): it hands
 *   the answer in with the next tool result while the run works, and submits no prompt, since
 *   none would run. So `ask` promises none: after the run, only `wait` brings the answer.
 * - `extension`: the Pi extension or the opencode plugin take it the same way.
 * - `codex`: the agent steers it into the Codex session, or queues it there.
 * - `agy`: the agent sends it to the Antigravity conversation's language server; the Stop hook
 *   takes it once that gave up (#1278).
 * - `t3`: the agent sends it to the T3 Code thread (#2244). For a Claude Code session
 *   (`t3.mod`), its mod takes it instead while the mod runs, since only the mod puts one into a
 *   running turn.
 */
export type Route =
  | { kind: "mod" }
  | { kind: "turn" }
  | { kind: "extension" }
  | { kind: "codex"; codex: CodexSession }
  | { kind: "agy"; antigravity: AgyRoute }
  | { kind: "t3"; t3: T3Route };

/** What the agent sees when the question is asked. */
export interface Observed {
  /** The Codex session's app-server, or the Antigravity conversation's language server, answers. */
  reachable: boolean;
  /** A mod polled for this session lately (for Cursor: its conversation is open). */
  modSeen: boolean;
  /** That mod's hello said `headless`: a `claude -p` run (#2258). */
  headless?: boolean;
  /** This agent can send to the T3 Code thread the ask names (`t3 thread send`). */
  t3: boolean;
}

/**
 * The route, or none, in which case only `wait` brings the answer. With no local agent, nothing
 * is observed: nothing delivers to Codex, Antigravity or T3, and no mod is known to run (#537).
 */
export function routeFor(
  input: Pick<
    AskInput,
    | "agent"
    | "session"
    | "held"
    | "wait"
    | "codex"
    | "antigravity"
    | "extensionAnswers"
    | "headless"
    | "subagent"
    | "t3"
  >,
  seen: Observed,
): Route | undefined {
  // A route goes into a session; `ask --wait` and a held question print their answer themselves.
  if (!input.session || input.held || input.wait) return undefined;
  const t3 = input.t3 && seen.t3 ? input.t3 : undefined;
  switch (input.agent) {
    case "antigravity":
      return input.antigravity && seen.reachable
        ? { kind: "agy", antigravity: input.antigravity }
        : undefined;
    case "claude-code":
    case "cursor": {
      // The mod runs its loop only in a session that stays open (#863, #2100), so a seen mod
      // outweighs `headless`, which Agent SDK sessions carry as `claude -p` does. Only the mod
      // names a subagent, so one runs in this session (#1702).
      if (!(seen.modSeen || (!input.headless && !!input.subagent))) return undefined;
      if (seen.modSeen && seen.headless) return { kind: "turn" };
      // T3 carries a Claude Code session's answer only behind its mod (#2244).
      return t3 && input.agent === "claude-code" && seen.modSeen
        ? { kind: "t3", t3: { thread: t3, mod: true } }
        : { kind: "mod" };
    }
    case "pi":
    case "opencode":
      if (!input.extensionAnswers) return undefined;
      // T3 brings it in place of the extension, which would run it where T3 never shows it.
      return t3 ? { kind: "t3", t3: { thread: t3 } } : { kind: "extension" };
    case "codex":
      // T3 runs the thread on its own app-server: `codex queue` would load it into a second,
      // hidden one (#2101).
      if (t3) return { kind: "t3", t3: { thread: t3 } };
      return input.codex && seen.reachable ? { kind: "codex", codex: input.codex } : undefined;
    default:
      return undefined;
  }
}

/**
 * The route of a recorded question. One recorded before #2284 has its route's parts as fields of
 * their own, and one with a session and none of them went to whatever took the session's events.
 */
export function routeOf(asked: State["asked"][string] | undefined): Route | undefined {
  if (!asked?.session) return undefined;
  if (asked.route !== undefined) return asked.route ?? undefined;
  if (asked.codex) return { kind: "codex", codex: asked.codex };
  if (asked.antigravity) return { kind: "agy", antigravity: asked.antigravity };
  if (asked.t3) return { kind: "t3", t3: asked.t3 };
  return asked.extensionAnswers ? { kind: "extension" } : { kind: "mod" };
}
