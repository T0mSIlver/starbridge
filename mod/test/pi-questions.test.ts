import { expect, test } from "bun:test";
import { dialogAnswers, hookQuestions, questionnaires } from "../pi/questions.ts";

/** A questionnaire as rpiv-ask-user-question 2.12.0's `rpiv:ask-user:prompt` carries it. */
const DB = {
  question: "Which database should the cache use?",
  header: "Cache",
  multiSelect: false,
  options: [
    { label: "Redis (Recommended)", description: "Already deployed", hasPreview: false },
    { label: "Postgres", description: "One less service", hasPreview: false },
  ],
};
const CHECKS = {
  question: "Which checks should run?",
  header: "Checks",
  multiSelect: true,
  options: [
    { label: "Lint", description: "", hasPreview: false },
    { label: "Tests", description: "", hasPreview: false },
  ],
};
const SESSION = { id: "s1", cwd: "/work/shop" };

/**
 * Pi's shared `ui` with the package's dialog: `custom` resolves when the dialog's `done` is
 * called, as Pi's does. `ui` is undefined for Pi's RPC mode, where no `custom` dialog opens.
 */
function harness(out: string, rpc = false) {
  const sent: { stdin: string; signal: AbortSignal }[] = [];
  const submitted: string[] = [];
  const closed: unknown[] = [];
  const ui: { custom?: (factory: unknown, options?: unknown) => unknown } = {
    custom: (factory) =>
      new Promise((resolve) => {
        (factory as (...a: unknown[]) => unknown)({}, {}, {}, (r: unknown) => {
          closed.push(r);
          resolve(r);
        });
      }),
  };
  let release = () => {};
  const q = questionnaires({
    hook: (stdin, signal) =>
      new Promise((resolve) => {
        sent.push({ stdin, signal });
        release = () => resolve(out);
        signal.addEventListener("abort", () => resolve(""));
      }),
    submit: (t) => submitted.push(t),
    notify: () => {},
  });
  /** The package's tool: the prompt event, then its dialog. */
  const ask = (questions: unknown[]) => {
    q.watch(ui);
    const done = q.prompt({ questions }, SESSION);
    q.blocked({ active: true });
    if (!rpc) void ui.custom?.(() => ({}), {});
    return done;
  };
  return { q, ask, sent, submitted, closed, release: () => release() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a device's answer closes the package's dialog as a keyboard submit does", async () => {
  const h = harness(JSON.stringify({ answers: [["Postgres"], ["Lint", "Tests"]] }));
  const done = h.ask([DB, CHECKS]);
  await tick();
  expect(JSON.parse(h.sent[0]?.stdin ?? "")).toEqual({
    session_id: "s1",
    cwd: "/work/shop",
    questions: hookQuestions([DB, CHECKS]),
  });
  h.release();
  await done;
  expect(h.closed).toEqual([
    {
      cancelled: false,
      answers: [
        { questionIndex: 0, question: DB.question, kind: "option", answer: "Postgres" },
        {
          questionIndex: 1,
          question: CHECKS.question,
          kind: "multi",
          answer: null,
          selected: ["Lint", "Tests"],
        },
      ],
    },
  ]);
  expect(h.submitted).toEqual([]);
});

test("with no dialog to close (Pi's RPC mode), the answer comes as a follow-up message", async () => {
  const h = harness(JSON.stringify({ answers: [["Postgres"]] }), true);
  const done = h.ask([DB]);
  await tick();
  h.release();
  await done;
  expect(h.closed).toEqual([]);
  expect(h.submitted).toEqual([
    "My answers to your ask_user_question, given on my devices:\n- Which database should the cache use? Postgres",
  ]);
});

test("the questionnaire answered at the keyboard stops the CLI, which settles the cards", async () => {
  const h = harness(JSON.stringify({ answers: [["Postgres"]] }));
  const done = h.ask([DB]);
  await tick();
  h.q.close();
  await done;
  expect(h.sent[0]?.signal.aborted).toBe(true);
  expect(h.closed).toEqual([]);
  expect(h.submitted).toEqual([]);
});

test("typed words, or a single-select reply naming two labels, are typed text", () => {
  expect(dialogAnswers([DB, CHECKS], [["Use SQLite"], ["Lint", "Docs"]])).toEqual([
    { questionIndex: 0, question: DB.question, kind: "custom", answer: "Use SQLite" },
    { questionIndex: 1, question: CHECKS.question, kind: "custom", answer: "Lint, Docs" },
  ]);
  expect(dialogAnswers([DB], [["Postgres", "Redis (Recommended)"]])[0]).toMatchObject({
    kind: "custom",
    answer: "Postgres, Redis (Recommended)",
  });
});

test("a dialog another extension opens before the package's blocked event keeps its own close", async () => {
  const h = harness(JSON.stringify({ answers: [["Postgres"]] }), true);
  const ui = { custom: (f: unknown) => f };
  h.q.watch(ui);
  const done = h.q.prompt({ questions: [DB] }, SESSION);
  const factory = () => "theirs";
  expect(ui.custom(factory)).toBe(factory);
  await tick();
  h.release();
  await done;
  expect(h.submitted).toHaveLength(1);
});

test("a dialog another extension opens, with no questionnaire announced, is left alone", async () => {
  const h = harness("");
  h.q.watch({});
  const ui = { custom: (f: unknown) => f };
  h.q.watch(ui);
  h.q.watch(ui);
  const factory = () => "mine";
  expect(ui.custom(factory)).toBe(factory);
});
