/**
 * Pi's most used question tool, `ask_user_question` from @juicesharp/rpiv-ask-user-question,
 * raced on the devices (#966), as opencode's `question` is (#345). The package announces each
 * questionnaire on its `rpiv:ask-user:prompt` event; `starbridge hook question --agent pi` posts
 * its questions, already waiting, and prints the answers once all are in. The tool returning,
 * whoever answered, stops the CLI, which settles the questions still open as answered elsewhere.
 *
 * The package has no way in for an answer (juicesharp/rpiv-mono#207 proposes one). But Pi gives
 * every extension the same `ctx.ui`, so `watch` wraps its `custom` and keeps the `done` callback
 * of the questionnaire's dialog, the `custom` call the package makes right after it emits
 * `rpiv:ask-user:blocked` with `active: true`: a device answer closes it as a keyboard submit does. Where the
 * questionnaire is not a `custom` dialog (Pi's RPC mode), the answer reaches the agent as a
 * follow-up message once it is closed at the keyboard.
 */
import { answersOf } from "../hooks/node.ts";

export const TOOL = "ask_user_question";
export const PROMPT_EVENT = "rpiv:ask-user:prompt";
export const BLOCKED_EVENT = "rpiv:ask-user:blocked";

/** Marks a `ui.custom` this module wrapped. */
const WRAPPED = Symbol.for("starbridge.questionnaire");

/** One question of the prompt event (events.ts in the package). */
export interface RpivQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** One answer as the package's dialog gives it (`QuestionAnswer` in its tool/types.ts). */
export type QuestionAnswer = { questionIndex: number; question: string } & (
  | { kind: "option" | "custom"; answer: string }
  | { kind: "multi"; answer: null; selected: string[] }
);

type Done = (result: { answers: QuestionAnswer[]; cancelled: false }) => void;
type Custom = ((factory: unknown, options?: unknown) => unknown) & { [WRAPPED]?: true };

/** The prompt event's questions, if it carries any. */
export function promptQuestions(data: unknown): RpivQuestion[] | undefined {
  const qs = (data as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return undefined;
  const ok = qs.every(
    (q) =>
      typeof q?.question === "string" &&
      Array.isArray(q.options) &&
      q.options.every((o: { label?: unknown }) => typeof o?.label === "string"),
  );
  return ok ? (qs as RpivQuestion[]) : undefined;
}

/** The questions as `hook question` reads them, in opencode's shape. */
export function hookQuestions(qs: RpivQuestion[]) {
  return qs.map((q) => ({
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    options: q.options.map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
    multiple: q.multiSelect === true,
  }));
}

/**
 * The dialog's answers: a reply that names only the question's labels picks them (one, unless
 * several may be picked), any other is typed text, as the "Type something." row gives.
 */
export function dialogAnswers(qs: RpivQuestion[], answers: string[][]): QuestionAnswer[] {
  return qs.map((q, questionIndex) => {
    const given = answers[questionIndex] ?? [];
    const base = { questionIndex, question: q.question };
    const labels = given.every((a) => q.options.some((o) => o.label === a));
    if (q.multiSelect === true && given.length > 0 && labels)
      return { ...base, kind: "multi", answer: null, selected: given };
    if (q.multiSelect !== true && given.length === 1 && labels)
      return { ...base, kind: "option", answer: given[0] as string };
    return { ...base, kind: "custom", answer: given.join(", ") };
  });
}

/** The follow-up message for a questionnaire that cannot take the answer. */
export function followUp(qs: RpivQuestion[], answers: string[][]): string {
  const lines = qs.map((q, i) => `- ${q.question} ${(answers[i] ?? []).join(", ")}`);
  return ["My answers to your ask_user_question, given on my devices:", ...lines].join("\n");
}

export interface Deps {
  /** `starbridge hook question --agent pi` with `stdin`; what it printed. */
  hook(stdin: string, signal: AbortSignal): Promise<string>;
  /** Submits a user message into the session once the agent is done. */
  submit(text: string): void;
  /** Says something at the keyboard. */
  notify(text: string): void;
}

/** Races each questionnaire on the devices; `close` when its tool returns or the session ends. */
export function questionnaires(deps: Deps) {
  const open = new Set<AbortController>();
  /** The questionnaire announced last, while its CLI runs. */
  let latest: { done?: Done } | undefined;
  /** That questionnaire, between its blocked event and its dialog's `custom` call. */
  let armed: { done?: Done } | undefined;

  return {
    /** Wraps `ui.custom`, once, so the dialog that follows a blocked event gives up its `done`. */
    watch(ui: { custom?: Custom }) {
      const custom = ui.custom;
      if (typeof custom !== "function" || custom[WRAPPED]) return;
      const wrapped: Custom = (factory, options) => {
        const q = armed;
        armed = undefined;
        if (!q || typeof factory !== "function") return custom.call(ui, factory, options);
        const keep = (...args: unknown[]) => {
          if (typeof args[3] === "function") q.done = args[3] as Done;
          return factory(...args);
        };
        return custom.call(ui, keep, options);
      };
      wrapped[WRAPPED] = true;
      ui.custom = wrapped;
    },
    async prompt(data: unknown, session: { id: string; cwd: string }) {
      const qs = promptQuestions(data);
      if (!qs) return;
      const q: { done?: Done } = {};
      latest = q;
      const stop = new AbortController();
      open.add(stop);
      const out = await deps.hook(
        JSON.stringify({ session_id: session.id, cwd: session.cwd, questions: hookQuestions(qs) }),
        stop.signal,
      );
      open.delete(stop);
      if (latest === q) latest = undefined;
      // Stopped: the questionnaire was answered or dismissed at the keyboard.
      const answers = stop.signal.aborted ? undefined : answersOf(out, qs.length);
      if (!answers) return;
      if (q.done) return q.done({ answers: dialogAnswers(qs, answers), cancelled: false });
      deps.notify("Answered on your devices: the agent gets it once this questionnaire closes.");
      deps.submit(followUp(qs, answers));
    },
    /** The package's blocked event: it opens its dialog at once after `active: true`. */
    blocked(data: unknown) {
      armed = (data as { active?: unknown } | undefined)?.active === true ? latest : undefined;
    },
    close() {
      for (const stop of open) stop.abort();
      open.clear();
    },
  };
}
