/**
 * Every harness's question hook and permission hook through the same failure cases (#2265). A
 * failure fixed on one path stayed broken on the others (#1226, #1286, #1288, #1289, #1225), so a
 * harness joins the table, or marks the case it lacks with a reason.
 *
 * - stalled post: the server never answers the post of the card; the hook still ends, at its
 *   deadline or when the terminal answers (#1288).
 * - stalled report: the card is open, then the server stops answering; closing it gives up within
 *   REPORT_MS instead of holding the hook until the harness kills it (#1286).
 * - lost reply: the server stores the card and its reply never comes back; the card is
 *   settled once, and the CLI kept its record, so no answer is dropped (#1289).
 * - snooze: a device snoozes the question; the hook keeps waiting and takes the answer after (#1226).
 * - session end: every card the session opened closes. The CLI handles the end of a Claude Code
 *   and a Codex session (`hook settle`) and Codex's turn end (the race); for the others the plugin
 *   ends the session by SIGTERM-ing each hook it holds, which is the event driven here. The
 *   opencode plugin's half (`session.deleted`, #1225) is in mod/test/opencode.test.ts.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import type { ServerWebSocket } from "bun";
import { makeAgent } from "../src/agent/main";
import type { Agent } from "../src/agent/server";
import { run } from "../src/cli";
import { codexControlSocket } from "../src/codex-app";
import { hookCodexQuestion } from "../src/codex-question";
import { hookPermission, hookQuestion, hookSettle } from "../src/hook";
import { agentAddress, paired, type TestCtx, until } from "./helpers";

setDefaultTimeout(40_000);

const SESSION = "11a021ff-830c-44cb-984e-328c53fadf77";
const CODEX_SESSION = "019a0b1c-codex-thread";
const CALL = "call_31";

type CaseName = "stalledPost" | "stalledReport" | "lostReply" | "snooze" | "sessionEnd";
const CASES: Record<CaseName, string> = {
  stalledPost: "a stalled post ends the hook within its bound",
  stalledReport: "a stalled report of the card's end ends the hook within its bound",
  lostReply: "a post that lost its reply is settled and its record kept",
  snooze: "a snooze keeps the hook waiting",
  sessionEnd: "the session's end closes every card it opened",
};

/** `run`: the shared case; `na`: why the harness cannot have it; `todo`: a bug on main. */
type How = "run" | { na: string } | { todo: string };

interface Handle {
  done: Promise<unknown>;
  /** The terminal answers, or SIGTERM: what a hook is stopped by. */
  cut: () => void;
}

interface Rig {
  server: LiveServer;
  ctx: TestCtx;
  cleanups: (() => unknown)[];
}

interface Row {
  name: string;
  /** What the hook posts. */
  card: "decision" | "permission";
  /** A question hook runs on the server's own; a permission hook with or without a local agent. */
  rig: "question" | "agent" | "server";
  /** The row needs a unix socket. */
  unix?: boolean;
  /** Starts the hook, with `cards` cards open: questions of one call, or one hook for each. */
  start: (r: Rig, cards: number, o?: { wait?: string }) => Promise<Handle>;
  /** The event the CLI handles at the session's end; the hook's cut where it handles none. */
  end?: (r: Rig, h: Handle) => Promise<unknown>;
  /** How a terminal's cut settles the card, and the hook's own deadline where it has one. */
  outcome: { terminal: string; deadline?: string };
  /** The label a device answers with, and whether the hook handed it on. */
  choice?: string;
  delivered?: (r: Rig) => boolean;
  cases: Record<CaseName, How>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    for (const c of r.cleanups) await c();
    r.server.stop();
  }
});

async function rig(kind: Row["rig"]): Promise<Rig> {
  const server = await LiveServer.start();
  const ctx = await paired(server);
  const r: Rig = { server, ctx, cleanups: [] };
  rigs.push(r);
  if (kind !== "question") {
    expect(await run(["config", "permissions", "on"], ctx)).toBe(0);
    if (kind === "server") ctx.env.STARBRIDGE_NO_AGENT = "1";
    else {
      const a: Agent = makeAgent(ctx, { socket: agentAddress(ctx.store.dir), noQuota: true });
      await a.start();
      r.cleanups.push(() => a.stop());
    }
  }
  ctx.lines.length = 0;
  return r;
}

/** How long `p` took, or Infinity when it was still pending after `ms`. */
async function took(p: Promise<unknown>, ms: number) {
  const t = Date.now();
  const ended = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    Bun.sleep(ms).then(() => false),
  ]);
  return ended ? Date.now() - t : Number.POSITIVE_INFINITY;
}

const stored = async (row: Row, r: Rig) => (await r.server.opened(row.card)) as { id: string }[];
/** The card is on the server and, for a decision, marked waiting. */
const live = async (row: Row, r: Rig) =>
  (await r.server.opened(row.card === "decision" ? "waiting" : "permission")) as unknown[];
const open = (row: Row, r: Rig, n: number, wait = live) =>
  until(async () => (await wait(row, r)).length >= n, 10_000);

// ---- hook drivers ----

const QUESTIONS = [
  {
    question: "Which database should the cache use?",
    header: "Database",
    options: [
      { label: "SQLite (Recommended)", description: "One file, no server" },
      { label: "Redis", description: "Shared across machines" },
    ],
  },
  { question: "Name the branch?", header: "Branch", options: [] },
];

const NO_REPORT_DEADLINE = {
  todo: "its settle of the open cards has no deadline: hookQuestion calls settle without one, so a server that stops answering holds the hook until the harness kills it (#1286's fix reached only the picker; #2278)",
};

function questionRow(
  agent: "opencode" | "pi" | "antigravity",
  cases: Partial<Record<CaseName, How>> = {},
): Row {
  return {
    name: `${agent} question`,
    card: "decision",
    rig: "question",
    outcome: { terminal: "elsewhere" },
    choice: "Redis",
    delivered: (r) => r.ctx.lines.some((l) => l.includes('"Redis"')),
    start: async (r, cards) => {
      const stop = new AbortController();
      const input = JSON.stringify({
        session_id: SESSION,
        cwd: "/work/cache",
        questions: QUESTIONS.slice(0, cards),
      });
      return {
        done: hookQuestion({ ...r.ctx, signal: stop.signal }, input, { agent }),
        cut: () => stop.abort(),
      };
    },
    cases: {
      stalledPost: "run",
      stalledReport: "run",
      lostReply: "run",
      snooze: "run",
      sessionEnd: "run",
      ...cases,
    },
  };
}

const PICKED = [
  {
    question: "Which color?",
    header: "Color",
    options: [
      { label: "Red (Recommended)", description: "Pick red." },
      { label: "Blue", description: "Pick blue." },
    ],
    multiSelect: false,
  },
  {
    question: "Which sizes?",
    header: "Sizes",
    options: [
      { label: "S", description: "Small" },
      { label: "L, tall", description: "Large" },
    ],
    multiSelect: true,
  },
];

/** Claude Code's AskUserQuestion picker, raced by `hook permission`. */
const claudeQuestion: Row = {
  name: "Claude Code question (picker)",
  card: "decision",
  rig: "question",
  outcome: { terminal: "elsewhere", deadline: "withdrawn" },
  choice: "Blue",
  delivered: (r) => r.ctx.lines.some((l) => l.includes("hookSpecificOutput")),
  start: async (r, cards, o) => {
    const stop = new AbortController();
    const input = JSON.stringify({
      session_id: SESSION,
      cwd: "/work/starbridge",
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions: PICKED.slice(0, cards) },
    });
    return {
      done: hookPermission({ ...r.ctx, signal: stop.signal }, input, {
        agent: "claude-code",
        ...(o?.wait ? { wait: o.wait } : {}),
      }),
      cut: () => stop.abort(),
    };
  },
  end: (r) =>
    hookSettle(r.ctx, JSON.stringify({ session_id: SESSION, hook_event_name: "SessionEnd" }), {
      agent: "claude-code",
    }),
  cases: {
    stalledPost: "run",
    stalledReport: "run",
    lostReply: "run",
    snooze: "run",
    sessionEnd: "run",
  },
};

/** What the Claude Code, opencode, Pi and Antigravity hooks and Codex's get on a prompt. */
function request(session: string, k: number) {
  return JSON.stringify({
    session_id: session,
    cwd: "/work/starbridge",
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: `git push origin branch-${k}`, description: "Push the fix" },
    permission_suggestions: [],
  });
}

const NO_SNOOZE = {
  na: "a prompt can't be snoozed (spec/items.md): its 10-minute window is the keyboard's",
};

function permissionRow(
  agent: "claude-code" | "codex" | "opencode" | "pi" | "antigravity",
  via: "agent" | "server",
  cases: Partial<Record<CaseName, How>> = {},
): Row {
  const session = agent === "codex" ? CODEX_SESSION : SESSION;
  // Claude Code and Codex end a session through `hook settle`; the others by SIGTERM.
  const settles = agent === "claude-code" || agent === "codex";
  return {
    name: `${agent} permission (${via === "agent" ? "through the agent" : "without an agent"})`,
    card: "permission",
    rig: via,
    // Cut at its deadline, the hook settles it as a timeout; through the agent, by its call.
    outcome: { terminal: "keyboard", deadline: "timeout|keyboard" },
    start: async (r, cards, o) => {
      const stop = new AbortController();
      const hooks = Array.from({ length: cards }, (_, k) =>
        hookPermission({ ...r.ctx, signal: stop.signal }, request(session, k), {
          agent,
          ...(o?.wait ? { wait: o.wait } : {}),
        }),
      );
      return { done: Promise.all(hooks), cut: () => stop.abort() };
    },
    ...(settles
      ? {
          end: (r: Rig) =>
            hookSettle(
              r.ctx,
              JSON.stringify({
                session_id: session,
                hook_event_name: agent === "codex" ? "Stop" : "SessionEnd",
              }),
              { agent },
            ),
        }
      : {}),
    cases: {
      stalledPost: "run",
      stalledReport: "run",
      lostReply: "run",
      snooze: NO_SNOOZE,
      sessionEnd: "run",
      ...cases,
    },
  };
}

/**
 * A Codex daemon on a control socket in a throwaway `CODEX_HOME`: it lists `loaded` threads and,
 * on `thread/resume`, sends `request` as the TUI's pending picker (as codex-question.test.ts).
 */
function daemon(loaded: string[], request: object) {
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
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }));
        got.push(m);
        if (m.method === "initialize") reply({});
        if (m.method === "thread/loaded/list") reply({ data: loaded, nextCursor: null });
        if (m.method === "thread/resume") {
          reply({ thread: { id: CODEX_SESSION } });
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

const codexQuestion: Row = {
  name: "codex question (the race)",
  card: "decision",
  rig: "question",
  unix: true,
  outcome: { terminal: "elsewhere" },
  choice: "Blue",
  start: async (r, cards) => {
    const request = {
      id: 0,
      method: "item/tool/requestUserInput",
      params: {
        threadId: CODEX_SESSION,
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
            options: [{ label: "Red (Recommended)" }, { label: "Blue" }],
          },
          {
            id: "size",
            header: "Size",
            question: "Which size?",
            isOther: true,
            isSecret: false,
            options: [{ label: "S" }, { label: "L" }],
          },
        ].slice(0, cards),
      },
    };
    const d = daemon([CODEX_SESSION], request);
    r.cleanups.push(d.stop);
    r.ctx.env.CODEX_HOME = d.home;
    r.ctx.env.STARBRIDGE_NO_AGENT = "1";
    daemons.set(r, d);
    const pre = JSON.stringify({
      session_id: CODEX_SESSION,
      turn_id: "t1",
      cwd: "/work/starbridge",
      hook_event_name: "PreToolUse",
      tool_name: "request_user_input",
      tool_input: {},
      tool_use_id: CALL,
    });
    return {
      done: hookCodexQuestion(r.ctx, pre, true),
      // The keyboard answered the picker first.
      cut: () =>
        d.send({
          method: "serverRequest/resolved",
          params: { threadId: CODEX_SESSION, requestId: 0 },
        }),
    };
  },
  end: async (r) =>
    daemons.get(r)?.send({ method: "turn/completed", params: { threadId: CODEX_SESSION } }),
  delivered: (r) => daemons.get(r)?.got.some((m) => m.id === 0 && m.result !== undefined) ?? false,
  cases: {
    stalledPost: "run",
    stalledReport: NO_REPORT_DEADLINE,
    lostReply: "run",
    snooze: "run",
    sessionEnd: "run",
  },
};
const daemons = new WeakMap<Rig, ReturnType<typeof daemon>>();

const CURSOR_PERMISSIONS = {
  na: "Cursor runs no hook that can approve a call (spec/harnesses.md, #957): its prompts stay at the keyboard",
};
const CURSOR_QUESTIONS = {
  na: "Cursor runs no hook for its own askQuestion (spec/harnesses.md): only the model's `ask` posts, covered in cli.test.ts",
};

/** Cursor has no question or permission hook: the rows say so, case by case. */
const cursorRow = (hook: "question" | "permission", na: { na: string }): Row => ({
  name: `cursor ${hook}`,
  card: hook === "question" ? "decision" : "permission",
  rig: "question",
  outcome: { terminal: "none" },
  start: async () => {
    throw new Error("cursor has no such hook");
  },
  cases: {
    stalledPost: na,
    stalledReport: na,
    lostReply: na,
    snooze: na,
    sessionEnd: {
      na: `${na.na}; its sessionEnd only tells the local agent to drop the session (hook session, bye)`,
    },
  },
});

// ---- the cases ----

const IMPL: Record<CaseName, (row: Row) => Promise<void>> = {
  async stalledPost(row) {
    for (const cut of ["terminal", "deadline"] as const) {
      if (cut === "deadline" && row.outcome.deadline === undefined) continue;
      const r = await rig(row.rig);
      r.server.stalls.push("POST /items");
      const started = Date.now();
      const h = await row.start(r, 1, cut === "deadline" ? { wait: "2s" } : undefined);
      await until(() => !r.server.stalls.includes("POST /items"), 10_000);
      if (cut === "terminal") h.cut();
      const ms = await took(h.done, 8_000);
      h.cut();
      // The terminal's cut ends it at once; the hook's own deadline, 2 s from its start, soon after.
      const bound = cut === "terminal" ? 1_500 : 4_000 - (Date.now() - ms - started);
      expect([cut, ms < bound]).toEqual([cut, true]);
      expect(r.ctx.lines).toEqual([]);
    }
  },

  async stalledReport(row) {
    const r = await rig(row.rig);
    const h = await row.start(r, 1);
    await open(row, r, 1);
    r.server.stalls.push("POST /items", "POST /items", "POST /items");
    const ended = row.end ? row.end(r, h) : Promise.resolve(h.cut());
    expect(await took(ended, 9_000)).toBeLessThan(6_500);
    h.cut();
    expect(await took(h.done, 9_000)).toBeLessThan(6_500);
  },

  async lostReply(row) {
    for (const cut of ["terminal", "deadline"] as const) {
      const want = row.outcome[cut];
      if (want === undefined) continue;
      const r = await rig(row.rig);
      r.server.lostReplies.push("POST /items");
      const h = await row.start(r, 1, cut === "deadline" ? { wait: "2s" } : undefined);
      await open(row, r, 1, stored);
      if (cut === "terminal") h.cut();
      expect(await took(h.done, 8_000)).toBeLessThan(8_000);
      h.cut();
      await until(async () => (await r.server.opened("settled")).length >= 1, 10_000);
      const [card] = await stored(row, r);
      const settled = await r.server.opened("settled");
      expect([cut, settled.map((x) => x.itemId)]).toEqual([cut, [card?.id as string]]);
      expect([cut, want.split("|").includes(settled[0]?.outcome as string)]).toEqual([cut, true]);
      // Recorded before the post, so the card's answer finds its decision here.
      const state = r.ctx.store.state();
      expect(
        row.card === "decision"
          ? state.asked[card?.id as string]
          : state.permissions?.[card?.id as string],
      ).toBeDefined();
    }
  },

  async snooze(row) {
    const r = await rig(row.rig);
    const h = await row.start(r, 1);
    let ended = false;
    void h.done.then(() => {
      ended = true;
    });
    await open(row, r, 1);
    const [card] = await stored(row, r);
    await r.server.snooze(card?.id as string, new Date(Date.now() + 3_600_000));
    await Bun.sleep(1_500);
    expect(await r.server.opened("settled")).toEqual([]);
    expect(ended).toBe(false);
    await r.server.answer(card?.id as string, { choice: row.choice as string });
    expect(await took(h.done, 8_000)).toBeLessThan(8_000);
    expect(row.delivered?.(r)).toBe(true);
  },

  async sessionEnd(row) {
    const r = await rig(row.rig);
    const h = await row.start(r, 2);
    await open(row, r, 2);
    await (row.end ? row.end(r, h) : h.cut());
    // Claude Code stops a picker's hook itself once the call ends: here, the terminal's cut.
    await until(async () => (await r.server.opened("settled")).length >= 2, 10_000);
    h.cut();
    expect(await took(h.done, 10_000)).toBeLessThan(10_000);
    const cards = (await stored(row, r)).map((c) => c.id).sort();
    expect(cards).toHaveLength(2);
    await until(async () => (await r.server.opened("settled")).length >= 2, 10_000);
    const settled = await r.server.opened("settled");
    expect(settled.map((s) => s.itemId).sort()).toEqual(cards);
    expect([...new Set(settled.map((s) => s.outcome))]).toEqual([row.outcome.terminal as never]);
  },
};

// ---- the table ----

const ROWS: Row[] = [
  claudeQuestion,
  codexQuestion,
  questionRow("opencode", { stalledReport: NO_REPORT_DEADLINE }),
  questionRow("pi", { stalledReport: NO_REPORT_DEADLINE }),
  questionRow("antigravity", { stalledReport: NO_REPORT_DEADLINE }),
  cursorRow("question", CURSOR_QUESTIONS),
  ...(["agent", "server"] as const).flatMap((via) => [
    permissionRow("claude-code", via),
    permissionRow("codex", via),
    permissionRow("opencode", via),
    permissionRow("pi", via),
    permissionRow("antigravity", via),
  ]),
  cursorRow("permission", CURSOR_PERMISSIONS),
];

for (const row of ROWS)
  for (const name of Object.keys(CASES) as CaseName[]) {
    const how = row.cases[name];
    const title = `${row.name}: ${CASES[name]}`;
    const t = row.unix && process.platform === "win32" ? test.skip : test;
    if (how === "run") t(title, () => IMPL[name](row));
    else if ("na" in how) test.skip(`${title} (n/a: ${how.na})`, () => {});
    else test.todo(`${title} (bug on main: ${how.todo})`, () => IMPL[name](row));
  }

test("a case a harness lacks says why", () => {
  for (const row of ROWS)
    for (const how of Object.values(row.cases))
      if (how !== "run") expect(Object.values(how)[0]?.length).toBeGreaterThan(30);
});
