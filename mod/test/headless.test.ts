import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Line } from "../hooks/agent.ts";
import { Unread } from "../hooks/unread.ts";
import plugin from "../opencode/starbridge.ts";
import starbridge from "../pi/starbridge.ts";

setDefaultTimeout(30_000);

const LINE = "Answer to d1 (Ship it?): Yes";
const line = (text = LINE, ack = "d1"): Line => ({ text, ack });

async function until(check: () => boolean, ms = 10_000) {
  const by = Date.now() + ms;
  while (!check() && Date.now() < by) await Bun.sleep(20);
  expect(check()).toBe(true);
}

test("a line is submitted only while the turn runs, once, and confirmed only when the agent read it (#2280)", async () => {
  const unread = new Unread();
  const sent: string[] = [];
  const send = (lines: Line[]) => {
    sent.push(lines.map((l) => l.text).join("\n"));
    return true;
  };
  const claimed: string[][] = [];
  const claim = async (acks: string[]) => {
    claimed.push(acks);
    return acks;
  };
  // No turn runs: an idle session would start a turn of its own with it.
  expect(await unread.submit([line()], send)).toEqual([]);
  expect(sent).toEqual([]);

  unread.turn(true);
  // Taken by the harness, not confirmed: the run may exit before the agent reads it.
  expect(await unread.submit([line()], send)).toEqual([]);
  expect(await unread.submit([line()], send)).toEqual([]);
  expect(sent).toEqual([LINE]);
  // Another message, or one the agent read without it, confirms nothing.
  await unread.entered("run the tests", claim);
  expect(claimed).toEqual([]);
  await unread.entered(`ok\n${LINE}`, claim);
  expect(claimed).toEqual([["d1"]]);
  // A second line joins the first submit's message.
  expect(await unread.submit([line("Answer to d2 (Push?): No", "d2")], send)).toEqual([]);
  expect(sent.at(-1)).toBe("Answer to d2 (Push?): No");
});

test("a line the agent read whose confirmation failed is confirmed by the next poll; a refused submit is tried again", async () => {
  const unread = new Unread();
  unread.turn(true);
  let take = false;
  const send = () => take;
  expect(await unread.submit([line()], send)).toEqual([]);
  take = true;
  expect(await unread.submit([line()], send)).toEqual([]);
  await unread.entered(LINE, async () => []);
  expect(await unread.submit([line()], send)).toEqual(["d1"]);
  expect(await unread.submit([line()], () => true)).toEqual([]);
});

test("a line still unread when the turn ends stays unconfirmed, and is not submitted again after it", async () => {
  const unread = new Unread();
  unread.turn(true);
  const sent: string[] = [];
  const send = (lines: Line[]) => {
    sent.push(...lines.map((l) => l.text));
    return true;
  };
  await unread.submit([line()], send);
  unread.turn(false);
  await unread.entered(LINE, async (acks) => acks);
  expect(await unread.submit([line()], send)).toEqual([]);
  expect(sent).toEqual([LINE]);
});

interface Agent {
  calls: { method: string; path: string; body?: unknown }[];
  acks(): string[];
  hellos(): unknown[];
  stop(): void;
}

/** An agent that hands session events one answer until it is acked, on a unix socket. */
let dirs: string[] = [];
let stops: (() => void)[] = [];
const saved = { ...process.env };
const argv = [...process.argv];
beforeEach(() => {
  dirs = [];
  stops = [];
});
afterEach(() => {
  for (const stop of stops) stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  process.env = { ...saved };
  process.argv = argv;
});

function fakeAgent(): Agent {
  const dir = mkdtempSync(join(tmpdir(), "sb-headless-"));
  dirs.push(dir);
  const socket = join(dir, "agent.sock");
  const calls: Agent["calls"] = [];
  let acked = false;
  const server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : undefined;
      calls.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/v1/status") return Response.json({ ok: true });
      if (url.pathname.endsWith("/events"))
        return Response.json({
          events: acked ? [] : [{ type: "answer", ack: "d1", line: LINE }],
        });
      if (url.pathname.endsWith("/ack")) {
        acked = true;
        return Response.json({ acked: (body as { acks: string[] }).acks });
      }
      return Response.json({ version: "x" });
    },
  });
  stops.push(() => server.stop(true));
  Object.assign(process.env, {
    STARBRIDGE_AGENT_SOCKET: socket,
    STARBRIDGE_CONFIG_DIR: dir,
    HOME: dir,
  });
  delete process.env.STARBRIDGE_NO_AGENT;
  return {
    calls,
    acks: () =>
      calls
        .filter((c) => c.path.endsWith("/ack"))
        .flatMap((c) => (c.body as { acks: string[] }).acks),
    hellos: () => calls.filter((c) => c.path.endsWith("/hello")).map((c) => c.body),
    stop: () => server.stop(true),
  };
}

test("`pi -p` takes an answer by steer in its running turn, and the agent confirms it once the steered message is in the context (#2280)", async () => {
  const agent = fakeAgent();
  const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
  const steered: { text: string; options: unknown }[] = [];
  const pi = {
    on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    sendUserMessage: (text: string, options: unknown) => steered.push({ text, options }),
    events: { on: () => () => {} },
  };
  starbridge(pi as never);
  const ctx = {
    hasUI: false,
    cwd: "/work",
    sessionManager: { getSessionId: () => "p-1", getSessionFile: () => undefined },
    ui: { setStatus: () => {}, notify: () => {}, select: async () => undefined },
  };
  const fire = (event: string, e: unknown = {}) => handlers.get(event)?.(e, ctx);
  await fire("session_start", { type: "session_start" });
  // `ask` promises no prompt here, and its CLI path takes no lease.
  expect(process.env.STARBRIDGE_PI_ANSWERS).toBeUndefined();
  // The turn has not started: nothing may start one with the answer.
  await Bun.sleep(300);
  expect(steered).toEqual([]);
  fire("agent_start");
  await until(() => steered.length > 0, 5_000);
  expect(steered).toEqual([{ text: LINE, options: { deliverAs: "steer" } }]);
  expect(agent.hellos()[0]).toEqual({ cwd: "/work", headless: true });
  // Steered is not read: the run may exit before the agent gets to it, and then `wait` prints it.
  await Bun.sleep(2_500);
  expect(steered).toHaveLength(1);
  expect(agent.acks()).toEqual([]);
  await fire("message_start", { message: { role: "user", content: "other prompt" } });
  await fire("message_start", { message: { role: "assistant", content: LINE } });
  expect(agent.acks()).toEqual([]);
  // The steered message enters the context.
  await fire("message_start", {
    message: { role: "user", content: [{ type: "text", text: LINE }] },
  });
  expect(agent.acks()).toEqual(["d1"]);
  fire("agent_end");
  await fire("session_shutdown", { reason: "quit" });
});

test("`opencode run` submits an answer in its running turn, and the agent confirms it once the message is in the session (#2280)", async () => {
  const agent = fakeAgent();
  process.argv = [...argv.slice(0, 2), "run", "hi"];
  const prompts: string[] = [];
  const client = {
    session: {
      get: async () => ({ data: { title: "cache" } }),
      promptAsync: async (o: { body: { parts: { text: string }[] } }) => {
        prompts.push(o.body.parts.map((p) => p.text).join(""));
        return {};
      },
    },
    _client: { post: async () => ({}) },
  };
  const h = await plugin.server({ client, directory: "/work" } as never);
  const event = (e: unknown) => h.event({ event: e } as never);
  try {
    // The first command of a run comes during its turn: it starts the loop.
    const out = { env: {} as Record<string, string> };
    await h["shell.env"]({ sessionID: "ses_1" }, out);
    expect(out.env.STARBRIDGE_OPENCODE_SESSION).toBe("ses_1");
    // `ask` promises no prompt here.
    expect(out.env.STARBRIDGE_OPENCODE_ANSWERS).toBeUndefined();
    await until(() => prompts.length > 0, 5_000);
    expect(prompts).toEqual([LINE]);
    expect(agent.hellos()[0]).toEqual({ cwd: "/work", headless: true });
    // Submitted is not read: `promptAsync` returns before the message is in the session.
    await Bun.sleep(2_500);
    expect(prompts).toHaveLength(1);
    expect(agent.acks()).toEqual([]);
    const user = (id: string) => ({
      type: "message.updated",
      properties: { info: { id, sessionID: "ses_1", role: "user" } },
    });
    const part = (messageID: string, text: string) => ({
      type: "message.part.updated",
      properties: { part: { type: "text", text, messageID, sessionID: "ses_1" } },
    });
    // The model's own text, or a user message without the line, confirms nothing.
    await event({
      type: "message.updated",
      properties: { info: { id: "m_a", sessionID: "ses_1", role: "assistant" } },
    });
    await event(part("m_a", LINE));
    await event(user("m_1"));
    await event(part("m_1", "say hi"));
    await Bun.sleep(100);
    expect(agent.acks()).toEqual([]);
    await event(user("m_2"));
    await event(part("m_2", LINE));
    await until(() => agent.acks().length > 0);
    expect(agent.acks()).toEqual(["d1"]);
  } finally {
    await h.dispose();
  }
});

test("`opencode run` submits no answer once its turn is idle, which would start one nobody watches", async () => {
  const agent = fakeAgent();
  process.argv = [...argv.slice(0, 2), "run", "hi"];
  const prompts: string[] = [];
  const client = {
    session: {
      get: async () => ({ data: {} }),
      promptAsync: async (o: { body: { parts: { text: string }[] } }) => {
        prompts.push(o.body.parts.map((p) => p.text).join(""));
        return {};
      },
    },
    _client: { post: async () => ({}) },
  };
  const h = await plugin.server({ client, directory: "/work" } as never);
  try {
    await h["shell.env"]({ sessionID: "ses_1" }, { env: {} });
    await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never);
    await Bun.sleep(2_500);
    expect(prompts).toEqual([]);
    expect(agent.acks()).toEqual([]);
  } finally {
    await h.dispose();
  }
});
