import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { LiveServer } from "@starbridge/server/test-support";
import { run } from "../src/cli";
import { hookQuestion, questionInput } from "../src/hook";
import { paired, testCtx, until } from "./helpers";

setDefaultTimeout(30_000);

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

const SESSION = "ses_1a2b3c";

/** A `question` tool call as opencode 1.18.31's `question.asked` carries it. */
const DB = {
  question: "Which database should the cache use?",
  header: "Database",
  options: [
    { label: "SQLite (Recommended)", description: "One file, no server" },
    { label: "Redis", description: "Shared across machines" },
  ],
};
const NAME = { question: "Name the branch?", header: "Branch", options: [] };

const hookInput = (questions: unknown[]) =>
  JSON.stringify({ session_id: SESSION, cwd: "/work/cache", questions });

test("each question becomes a waiting card; once all are answered, opencode gets the labels, and the session's own loop gets nothing", async () => {
  const ctx = await paired(server);
  const done = hookQuestion(ctx, hookInput([DB, NAME]), { agent: "opencode" });
  await until(async () => (await server.opened("decision")).length === 2);
  const decisions = await server.opened("decision");
  const db = decisions.find((d) => d.question === DB.question);
  const name = decisions.find((d) => d.question === NAME.question);
  expect(db).toMatchObject({
    options: ["SQLite (Recommended)", "Redis"],
    recommended: "SQLite (Recommended)",
    context: "- SQLite (Recommended): One file, no server\n- Redis: Shared across machines",
    agent: "opencode",
    source: { session: SESSION, project: "cache" },
  });
  expect(name?.options).toEqual([]);
  await until(async () => (await server.opened("waiting")).length === 2);

  await server.answer(db?.id as string, { choice: "Redis" });
  await server.answer(name?.id as string, { text: "t/cache" });
  expect(await done).toBe(0);
  expect(ctx.lines).toEqual([JSON.stringify({ answers: [["Redis"], ["t/cache"]] })]);
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", SESSION], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);
});

test("the terminal answering first settles the questions still open, as answered elsewhere", async () => {
  const ctx = await paired(server);
  const stop = new AbortController();
  const done = hookQuestion({ ...ctx, signal: stop.signal }, hookInput([DB]), {
    agent: "opencode",
  });
  await until(async () => (await server.opened("waiting")).length === 1);
  stop.abort();
  expect(await done).toBe(0);
  expect(ctx.lines).toEqual([]);
  expect((await server.opened("settled")).map((s) => s.outcome)).toEqual(["elsewhere"]);
});

test("an unpaired machine prints nothing, so the terminal's dialog decides", async () => {
  const ctx = testCtx();
  expect(await hookQuestion(ctx, hookInput([DB]), { agent: "opencode" })).toBe(0);
  expect(ctx.lines).toEqual([]);
});

test("a question a card cannot offer as taps lists its options and takes a typed reply", () => {
  const five = ["A", "B", "C", "D", "E"].map((label) => ({ label, description: `${label}!` }));
  expect(questionInput({ question: "Which one?", options: five })).toEqual({
    question: "Which one?",
    context: "- A: A!\n- B: B!\n- C: C!\n- D: D!\n- E: E!",
  });
  expect(
    questionInput({ question: "Which?", options: DB.options, multiple: true }).context,
  ).toEndWith("More than one can apply: reply with each one you pick.");
  const long = "x".repeat(400);
  const q = questionInput({ question: long, options: DB.options });
  expect(q.question).toHaveLength(300);
  expect(q.context?.startsWith(long)).toBe(true);
});
