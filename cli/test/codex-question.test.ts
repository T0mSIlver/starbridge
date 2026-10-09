import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import type { ServerWebSocket } from "bun";
import { codexControlSocket } from "../src/codex-app";
import { hookCodexQuestion } from "../src/codex-question";
import { paired, type TestCtx, until } from "./helpers";

setDefaultTimeout(30_000);

/** The race reaches Codex's daemon over a unix socket, which it skips on Windows. */
const unix = test.skipIf(process.platform === "win32");

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

const THREAD = "01a12269-21e0-76b1-a454-ba51723c8e28";
const CALL = "call_31";

/** What Codex 0.160 gives the plugin's `PreToolUse` hook for `request_user_input`. */
const PRE_TOOL_USE = JSON.stringify({
  session_id: THREAD,
  turn_id: "t1",
  cwd: "/work/starbridge",
  hook_event_name: "PreToolUse",
  model: "gpt-6.1-sol",
  permission_mode: "default",
  tool_name: "request_user_input",
  tool_input: {},
  tool_use_id: CALL,
});

/** The daemon's request for the picker, as 0.160 sends it to the thread's clients. */
const REQUEST = {
  id: 0,
  method: "item/tool/requestUserInput",
  params: {
    threadId: THREAD,
    turnId: "t1",
    itemId: CALL,
    isBlocking: true,
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Red (Recommended)", description: "Pick red." },
          { label: "Blue", description: "Pick blue." },
        ],
      },
    ],
  },
};

/**
 * A Codex daemon on a control socket in a throwaway `CODEX_HOME`: it lists `loaded` threads and,
 * on `thread/resume`, sends `request` as the TUI's pending picker. `got` holds what the client
 * sent.
 */
function daemon(loaded: string[], request: object = REQUEST) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  mkdirSync(join(home, "app-server-control"));
  const got: { id?: number; method?: string; result?: unknown }[] = [];
  let peer: ServerWebSocket<unknown> | undefined;
  const listener = Bun.serve({
    unix: codexControlSocket(home),
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, text) {
        peer = ws;
        const m = JSON.parse(String(text));
        got.push(m);
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }));
        if (m.method === "initialize") reply({});
        if (m.method === "thread/loaded/list") reply({ data: loaded, nextCursor: null });
        if (m.method === "thread/resume") {
          reply({ thread: { id: THREAD } });
          ws.send(JSON.stringify(request));
        }
        if (m.method === "thread/unsubscribe") reply({ status: "unsubscribed" });
      },
    },
  });
  return {
    home,
    got,
    send: (m: object) => peer?.send(JSON.stringify(m)),
    stop: () => listener.stop(true),
  };
}

async function machine(home: string): Promise<TestCtx> {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_NO_AGENT = "1";
  ctx.env.CODEX_HOME = home;
  return ctx;
}

unix("a device answers Codex's request_user_input, and the picker takes it (#951)", async () => {
  const d = daemon([THREAD]);
  const ctx = await machine(d.home);
  const race = hookCodexQuestion(ctx, PRE_TOOL_USE, true);
  await until(async () => (await server.opened("decision")).length === 1, 10_000);
  const [card] = await server.opened("decision");
  expect(card).toMatchObject({
    agent: "codex",
    question: "Which color?",
    options: ["Red (Recommended)", "Blue"],
    recommended: "Red (Recommended)",
    source: { session: THREAD, project: "starbridge" },
  });
  await server.answer(card?.id as string, { text: "Green" });
  await race;
  expect(d.got.find((m) => m.id === 0)?.result).toEqual({
    answers: { color: { answers: ["user_note: Green"] } },
  });
  expect(d.got.at(-1)?.method).toBe("thread/unsubscribe");
  d.stop();
});

unix("answered at the keyboard first, the card is settled elsewhere (#951)", async () => {
  const d = daemon([THREAD]);
  const ctx = await machine(d.home);
  const race = hookCodexQuestion(ctx, PRE_TOOL_USE, true);
  await until(async () => (await server.opened("decision")).length === 1, 10_000);
  d.send({ method: "serverRequest/resolved", params: { threadId: THREAD, requestId: 0 } });
  await race;
  expect(d.got.some((m) => m.id === 0)).toBe(false);
  await until(async () => (await server.opened("settled")).length === 1);
  expect((await server.opened("settled"))[0]).toMatchObject({ outcome: "elsewhere" });
  d.stop();
});

unix(
  "a thread the daemon has not loaded, a secret, or no daemon leaves the picker alone (#951)",
  async () => {
    // `codex exec` runs its thread outside the daemon: resuming it there would load it.
    const exec = daemon(["another-thread"]);
    const ctx = await machine(exec.home);
    await hookCodexQuestion(ctx, PRE_TOOL_USE, true);
    expect(exec.got.map((m) => m.method)).not.toContain("thread/resume");
    exec.stop();

    const secret = structuredClone(REQUEST);
    (secret.params.questions[0] as { isSecret: boolean }).isSecret = true;
    const d = daemon([THREAD], secret);
    ctx.env.CODEX_HOME = d.home;
    await hookCodexQuestion(ctx, PRE_TOOL_USE, true);
    expect(d.got.some((m) => m.id === 0)).toBe(false);
    d.stop();

    // No daemon: the hook starts no race.
    ctx.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-home-"));
    let started = false;
    await hookCodexQuestion(ctx, PRE_TOOL_USE, false, () => {
      started = true;
    });
    expect(started).toBe(false);
    expect(ctx.lines).toEqual([]);
    expect(await server.opened("decision")).toEqual([]);
  },
);
