import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Antigravity, type RunHook } from "../src/agent/antigravity";
import type { Hub } from "../src/agent/server";
import { testCtx, until } from "./helpers";

/** The conversation's workspace, a real path on every platform. */
const WORK = tmpdir();

/** A fake language server with one running conversation whose step 2 waits for `asks`. */
function languageServer(asks: unknown) {
  const handled: unknown[] = [];
  let waiting = true;
  let failSteps = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").at(-1);
      const body = await req.json();
      if (req.headers.get("x-codeium-csrf-token") !== "tok")
        return new Response("", { status: 401 });
      if (method === "GetAllCascadeTrajectories")
        return Response.json({
          trajectorySummaries: {
            "c-1": {
              status: "CASCADE_RUN_STATUS_RUNNING",
              stepCount: 3,
              trajectoryId: "t-1",
              workspaces: [{ workspaceFolderAbsoluteUri: pathToFileURL(WORK).href }],
            },
          },
        });
      if (method === "GetCascadeTrajectorySteps" && failSteps)
        return new Response("", { status: 503 });
      if (method === "GetCascadeTrajectorySteps")
        return Response.json({
          steps: [
            { status: "CORTEX_STEP_STATUS_DONE" },
            { status: "CORTEX_STEP_STATUS_DONE" },
            waiting
              ? { status: "CORTEX_STEP_STATUS_WAITING", requestedInteraction: asks }
              : { status: "CORTEX_STEP_STATUS_DONE" },
          ],
        });
      if (method === "HandleCascadeUserInteraction") {
        handled.push(body);
        waiting = false;
        return Response.json({});
      }
      return new Response("", { status: 404 });
    },
  });
  return {
    route: { address: `127.0.0.1:${server.port}`, token: "tok" },
    handled,
    failSteps: (fail: boolean) => {
      failSteps = fail;
    },
    answerAtKeyboard: () => {
      waiting = false;
    },
    stop: () => server.stop(true),
  };
}

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

function watcher(runHook: RunHook) {
  const ctx = testCtx();
  ctx.store.saveAgentConfig({ permissions: { enabled: true } });
  const hub = { ctx, log: () => {} } as unknown as Hub;
  return new Antigravity(hub, runHook);
}

test("a device's answer to an Antigravity approval goes to its language server once (#962)", async () => {
  const ls = languageServer({
    permission: { resource: { action: "command", target: "rm -rf build" } },
  });
  stops.push(ls.stop);
  const runs: { args: string[]; input: unknown }[] = [];
  const w = watcher(async (args, input) => {
    runs.push({ args, input });
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });
  w.add(ls.route);
  await w.tick();
  await until(() => ls.handled.length === 1);
  // Shown as a command, as Claude Code's Bash is.
  expect(runs).toEqual([
    {
      args: ["hook", "permission", "--agent", "antigravity"],
      input: {
        session_id: "c-1",
        cwd: WORK,
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      },
    },
  ]);
  expect(ls.handled).toEqual([
    {
      cascadeId: "c-1",
      interaction: {
        trajectoryId: "t-1",
        stepIndex: 2,
        permission: { allow: true, scope: "PERMISSION_SCOPE_ONCE" },
      },
    },
  ]);
  await w.tick();
  expect(runs).toHaveLength(1);
});

test("a step answered at the keyboard stops its hook, which settles the question", async () => {
  const ls = languageServer({
    askQuestion: {
      questions: [
        {
          question: "Colour?",
          options: [
            { id: "1", text: "Red" },
            { id: "2", text: "Blue" },
          ],
        },
      ],
    },
  });
  stops.push(ls.stop);
  let stopped = false;
  const runs: unknown[] = [];
  const w = watcher(
    (_args, input, signal) =>
      new Promise((resolve) => {
        runs.push(input);
        signal.addEventListener("abort", () => {
          stopped = true;
          resolve("");
        });
      }),
  );
  w.add(ls.route);
  await w.tick();
  expect(runs).toEqual([
    {
      session_id: "c-1",
      cwd: WORK,
      questions: [
        { question: "Colour?", options: [{ label: "Red" }, { label: "Blue" }], multiple: false },
      ],
    },
  ]);
  // A read that fails says nothing about the step: its hook keeps waiting.
  ls.failSteps(true);
  await w.tick();
  expect(stopped).toBe(false);
  ls.failSteps(false);
  ls.answerAtKeyboard();
  await w.tick();
  expect(stopped).toBe(true);
  expect(ls.handled).toEqual([]);
});

test("a device's pick, or a typed reply, answers Antigravity's question by option id", async () => {
  const ls = languageServer({
    askQuestion: {
      questions: [
        {
          question: "Colour?",
          options: [
            { id: "1", text: "Red" },
            { id: "2", text: "Blue" },
          ],
        },
        { question: "Size?", options: [{ id: "1", text: "S" }] },
      ],
    },
  });
  stops.push(ls.stop);
  const w = watcher(async () => JSON.stringify({ answers: [["Blue"], ["XL"]] }));
  w.add(ls.route);
  await w.tick();
  await until(() => ls.handled.length === 1);
  expect(
    (ls.handled[0] as { interaction: { askQuestion: unknown } }).interaction.askQuestion,
  ).toEqual({
    responses: [
      { question: "Colour?", selectedOptionIds: ["2"] },
      { question: "Size?", selectedOptionIds: [], writeInResponse: "XL" },
    ],
  });
});
