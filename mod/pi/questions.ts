/**
 * Pi's most used question tool, `ask_user_question` from @juicesharp/rpiv-ask-user-question,
 * raced on the devices (#966), as opencode's `question` is (#345). The package announces each
 * questionnaire on its `rpiv:ask-user:prompt` event; `starbridge hook question --agent pi` posts
 * its questions, already waiting, and prints the answers once all are in. The tool returning,
 * whoever answered, stops the CLI, which settles the questions still open as answered elsewhere.
 *
 * From 2.13.9 the prompt event names the questionnaire by `toolCallId`, and the package takes an
 * answer on `rpiv:ask-user:answer` (juicesharp/rpiv-mono#207), with one verdict per attempt on
 * `rpiv:ask-user:answer-result`: a device answer goes that way, so questionnaires open at once
 * each get their own (#1516). Older releases have no way in: Pi gives every extension the same
 * `ctx.ui`, so `watch` wraps its `custom` and keeps the `done` callback of the questionnaire's
 * dialog, the `custom` call the package makes right after it emits `rpiv:ask-user:blocked` with
 * `active: true`. Where neither can close it (Pi's RPC mode, or an answer the package refused),
 * the answer reaches the agent as a follow-up message once it is closed at the keyboard.
 */
import { answersOf } from "../hooks/node.ts";

export const TOOL = "ask_user_question";
export const PROMPT_EVENT = "rpiv:ask-user:prompt";
export const BLOCKED_EVENT = "rpiv:ask-user:blocked";
export const ANSWER_EVENT = "rpiv:ask-user:answer";
export const RESULT_EVENT = "rpiv:ask-user:answer-result";

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
function promptQuestions(data: unknown): RpivQuestion[] | undefined {
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

/** The prompt event's `toolCallId`: set from 2.13.9, which takes answers on ANSWER_EVENT. */
function promptToolCall(data: unknown): string | undefined {
  const id = (data as { toolCallId?: unknown } | undefined)?.toolCallId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** One question's answer as ANSWER_EVENT takes it (`AskUserAnswerEntry` in the package). */
export interface AnswerEntry {
  questionIndex: number;
  optionIndexes?: number[];
  text?: string;
}

/**
 * The answers as ANSWER_EVENT takes them: a single-select reply that names one label picks it,
 * any other is typed text; a multi-select one picks the labels it names, and the rest is typed
 * text beside them, as the dialog's checked options and its "Type something." row give.
 */
export function answerEntries(qs: RpivQuestion[], answers: string[][]): AnswerEntry[] {
  return qs.map((q, questionIndex) => {
    const given = answers[questionIndex] ?? [];
    const index = (a: string) => q.options.findIndex((o) => o.label === a);
    if (q.multiSelect !== true) {
      const one = given.length === 1 ? index(given[0] as string) : -1;
      return one >= 0
        ? { questionIndex, optionIndexes: [one] }
        : { questionIndex, text: given.join(", ") };
    }
    const optionIndexes = [...new Set(given.map(index).filter((i) => i >= 0))];
    const typed = given.filter((a) => index(a) < 0).join(", ");
    return {
      questionIndex,
      ...(optionIndexes.length > 0 ? { optionIndexes } : {}),
      ...(typed.trim() !== "" || optionIndexes.length === 0 ? { text: typed } : {}),
    };
  });
}

/** The questions as `hook question` reads them, in opencode's shape. */
function hookQuestions(qs: RpivQuestion[]) {
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
  /** Emits on Pi's event bus, which every extension shares. */
  emit(event: string, data: unknown): void;
}

/** The package's verdict on one answer (`AskUserAnswerResultEventPayload`). */
interface Verdict {
  ok: boolean;
  code?: string;
}

/** How long a verdict may take: the package replies inside the emit, so this is a backstop. */
const VERDICT_MS = 5_000;

/** Races each questionnaire on the devices; `close` when its tool returns or the session ends. */
export function questionnaires(deps: Deps) {
  const open = new Set<AbortController>();
  /** The questionnaire announced last, while its CLI runs. */
  let latest: { done?: Done } | undefined;
  /** That questionnaire, between its blocked event and its dialog's `custom` call. */
  let armed: { done?: Done } | undefined;
  /** Answers sent on ANSWER_EVENT, by request id, until their verdict. */
  const verdicts = new Map<string, (v: Verdict) => void>();
  let requests = 0;

  /** Sends the answers into questionnaire `toolCallId`; its verdict, or undefined past VERDICT_MS. */
  const answer = (toolCallId: string, entries: AnswerEntry[]) =>
    new Promise<Verdict | undefined>((resolve) => {
      const requestId = `starbridge-${++requests}`;
      const timer = setTimeout(() => {
        verdicts.delete(requestId);
        resolve(undefined);
      }, VERDICT_MS);
      verdicts.set(requestId, (v) => {
        clearTimeout(timer);
        verdicts.delete(requestId);
        resolve(v);
      });
      deps.emit(ANSWER_EVENT, { toolCallId, requestId, answers: entries });
    });

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
      const toolCallId = promptToolCall(data);
      const q: { done?: Done } = {};
      // A release that takes answers by event needs no dialog of its own to close.
      latest = toolCallId ? undefined : q;
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
      if (toolCallId) {
        const verdict = await answer(toolCallId, answerEntries(qs, answers));
        // Accepted; or closed meanwhile, at the keyboard or by another answer.
        if (verdict?.ok || verdict?.code === "not_found") return;
        if (verdict?.code !== "unsupported_host")
          deps.notify("Starbridge could not put your devices' answer into this questionnaire.");
      } else if (q.done) return q.done({ answers: dialogAnswers(qs, answers), cancelled: false });
      deps.notify("Answered on your devices: the agent gets it once this questionnaire closes.");
      deps.submit(followUp(qs, answers));
    },
    /** The package's verdict on an answer this module sent. */
    result(data: unknown) {
      const v = data as { ok?: unknown; code?: unknown; requestId?: unknown } | undefined;
      if (typeof v?.requestId !== "string") return;
      verdicts.get(v.requestId)?.({
        ok: v.ok === true,
        ...(typeof v.code === "string" ? { code: v.code } : {}),
      });
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
