/**
 * Claude desktop's next-step box (#2118). Claude desktop gives its Claude Code sessions a
 * `wrap_up` tool that ends the turn with a recap and, with `ask`, a question and one button per
 * action; a click sends the action's `message` as the next prompt. Starbridge races it as it races
 * `AskUserQuestion`: the plugin's `PostToolUse` hook posts the question as a card, already
 * waiting, whose answer comes back as a prompt as every card's does. The session's next prompt,
 * a click in the box among them, settles the card as answered elsewhere (`UserPromptSubmit`).
 */
import type { Ctx } from "./context";
import { session } from "./context";
import { type AskInput, postDecision, resolveSource, settle } from "./decisions";
import { questionInput } from "./hook";
import { projectName } from "./project";

/** The tool, as Claude Code names a tool of the desktop app's `ccd_turn` server. */
export const NEXT_STEP_TOOL = "mcp__ccd_turn__wrap_up";

/** How long settling may hold up the session's prompt. */
const SETTLE_MS = 5_000;

interface Box {
  recap?: string;
  ask: string;
  actions: { label: string; message?: string }[];
}

/** The box's question and actions, or undefined for a recap alone, which asks nothing. */
export function nextStepBox(input: unknown): Box | undefined {
  const v = input as { recap?: unknown; ask?: unknown; actions?: unknown } | undefined;
  if (typeof v?.ask !== "string" || !v.ask.trim()) return undefined;
  const actions = Array.isArray(v.actions)
    ? v.actions.filter(
        (a): a is Box["actions"][number] =>
          typeof (a as { label?: unknown })?.label === "string" &&
          (a as { label: string }).label.trim().length > 0,
      )
    : [];
  return {
    ask: v.ask.trim(),
    actions,
    ...(typeof v.recap === "string" && v.recap.trim() ? { recap: v.recap.trim() } : {}),
  };
}

/** The card for a box: its question, the recap before it, its actions as the options. */
export function nextStepInput(box: Box): AskInput {
  return questionInput({
    question: box.ask,
    ...(box.recap ? { description: box.recap } : {}),
    options: box.actions.map((a) => ({ label: a.label })),
  });
}

interface HookInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  cursor_version?: unknown;
}

/**
 * `starbridge hook next-step --agent claude-code`, on `PostToolUse` for the box's tool: posts its
 * question for the session. Prints nothing; an error goes to stderr, and the box still waits.
 */
export async function hookNextStep(ctx: Ctx, stdin: string): Promise<number> {
  try {
    const hook = JSON.parse(stdin) as HookInput;
    const sessionId = typeof hook?.session_id === "string" ? hook.session_id : "";
    if (!sessionId || typeof hook.cursor_version === "string") return 0;
    if (hook.tool_name !== NEXT_STEP_TOOL) return 0;
    const box = nextStepBox(hook.tool_input);
    if (!box) return 0;
    const cwd = typeof hook.cwd === "string" && hook.cwd ? hook.cwd : process.cwd();
    const input: AskInput = {
      ...nextStepInput(box),
      agent: "claude-code",
      session: sessionId,
      project: projectName(cwd),
      // The turn has ended on the question: the session waits for the owner.
      waiting: true,
      nextStep: sessionId,
    };
    await postDecision({ ...ctx, out: () => {} }, session(ctx), resolveSource(input, ctx.env, cwd));
  } catch (e) {
    ctx.err(`starbridge: could not send the next-step question: ${(e as Error).message}`);
  }
  return 0;
}

/** The session's next-step cards still open. */
function openBoxes(ctx: Ctx, sessionId: string): string[] {
  const st = ctx.store.state();
  return Object.entries(st.asked)
    .filter(([id, a]) => a.nextStep === sessionId && !a.settled && !st.answers[id])
    .map(([id]) => id);
}

/**
 * `starbridge hook prompt --agent claude-code`, on `UserPromptSubmit`: a prompt in the session, a
 * click in the box or anything typed, answers its open next-step card elsewhere. A device's
 * answer, which comes back as that prompt, is no longer open.
 */
export async function hookPrompt(ctx: Ctx, stdin: string): Promise<number> {
  try {
    const hook = JSON.parse(stdin) as HookInput;
    const sessionId = typeof hook?.session_id === "string" ? hook.session_id : "";
    if (!sessionId || typeof hook.cursor_version === "string") return 0;
    const deadline = AbortSignal.timeout(SETTLE_MS);
    // What this hook prints joins the prompt: it prints nothing, not even an answer settle found.
    const quiet = { ...ctx, out: () => {}, err: () => {}, signal: undefined };
    await Promise.all(
      openBoxes(ctx, sessionId).map((id) =>
        settle(quiet, { id, outcome: "elsewhere", deadline }).catch((e) =>
          ctx.err(`starbridge: could not settle ${id}: ${(e as Error).message}`),
        ),
      ),
    );
  } catch (e) {
    ctx.err(`starbridge: could not settle the next-step question: ${(e as Error).message}`);
  }
  return 0;
}
