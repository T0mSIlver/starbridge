import type { Register } from "claude-code";
import {
  AgentLoop,
  HEADERS,
  isPortFile,
  PROOF_HEADER,
  pidRuns,
  portTarget,
  signCall,
  socketPath,
} from "./agent.ts";
import { Handover } from "./handover.ts";
import { configDir, Poller } from "./poller.ts";
import { Switch, wantsLoop } from "./switch.ts";

/**
 * Starts the answer loop in each session a person keeps open (`wantsLoop`): through the machine's agent when it runs
 * (agent.ts), else through the CLI (poller.ts); switch.ts picks. A hot reload loads this module
 * afresh: the old loop dies with the old module, and `session.start` starts a new one. While the
 * main agent's turn runs, an answer it marked waiting goes out with its next tool result
 * instead, and any other waits for the turn's end (handover.ts).
 */
export const register: Register = (on) => {
  let loop: Switch | undefined;
  /** Prompts submitted whose turn has not started. */
  let waiting = 0;
  // `$.prompt.submit` resolves when the prompt's turn starts: mid-turn, once the running one ends.
  const track = (submitted: Promise<unknown>) => {
    waiting++;
    const started = () => void waiting--;
    submitted.then(started, started);
  };
  const handover = new Handover();

  on("session.start", async ($, e, next) => {
    handover.ended();
    const started = await next(e);
    if (!wantsLoop(e.isInteractive, await $.env.get("CLAUDE_CODE_ENTRYPOINT"))) return started;
    // The new loop takes over the lines the old one submitted and has not confirmed yet, so it
    // confirms them rather than submitting them again (#1337).
    const before = loop;
    void before?.stop();
    const env = {
      STARBRIDGE_AGENT_SOCKET: await $.env.get("STARBRIDGE_AGENT_SOCKET"),
      STARBRIDGE_CONFIG_DIR: await $.env.get("STARBRIDGE_CONFIG_DIR"),
      STARBRIDGE_NO_AGENT: await $.env.get("STARBRIDGE_NO_AGENT"),
      XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
      XDG_RUNTIME_DIR: await $.env.get("XDG_RUNTIME_DIR"),
      HOME: await $.env.get("HOME"),
      USERPROFILE: await $.env.get("USERPROFILE"),
      OS: await $.env.get("OS"),
    };
    const dir = configDir(env);
    const socket = socketPath(env);
    const fetch = async (method: string, path: string, body?: unknown) => {
      const headers =
        body === undefined ? HEADERS : { ...HEADERS, "content-type": "application/json" };
      const init = { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      let r: Awaited<ReturnType<typeof $.http.fetch>>;
      if (isPortFile(socket)) {
        // Read each call: the agent writes a new port and token each time it starts.
        const t = portTarget(await $.fs.read(socket));
        const runs =
          t &&
          (await pidRuns(t.pid, env.OS === "Windows_NT", (argv) =>
            $.process.run(argv, { timeoutMs: 10_000 }),
          ));
        if (!t || !runs) throw new Error(`no agent on ${socket}`);
        const signed = await signCall(t.token);
        r = await $.http.fetch(`http://127.0.0.1:${t.port}${path}`, {
          ...init,
          headers: { ...headers, ...signed.headers },
        });
        if (r.headers[PROOF_HEADER] !== signed.expect)
          throw new Error(`no agent on ${socket}: the port answers without its proof`);
      } else
        r = await $.http.fetch(`http://agent${path}`, { ...init, socketPath: socket, headers });
      return { status: r.status, text: r.text };
    };
    const log = (text: string) => $.ui.log(text, { to: "debug" });
    const status = (text: string | undefined) => $.ui.status(text);
    const submit = (text: string, waiting: boolean) =>
      handover.submit(text, waiting, (line) => track($.prompt.submit({ text: line })));
    const starting = () => waiting > 0;
    const sessionId = () => $.session.id();
    const now = () => $.clock.now();
    const sleep = (ms: number) => $.clock.sleep(ms);
    loop = new Switch(
      {
        // The CLI honours STARBRIDGE_NO_AGENT too, so the CLI path then reaches the server itself.
        agentUp: async () =>
          !env.STARBRIDGE_NO_AGENT && (await fetch("GET", "/v1/status")).status < 300,
        agent: (unconfirmed) =>
          new AgentLoop(
            {
              sessionId,
              cwd: () => $.session.cwd(),
              fetch,
              now,
              sleep,
              submit,
              starting,
              status,
              log,
            },
            unconfirmed,
          ),
        poller: (unconfirmed) =>
          new Poller(
            {
              sessionId,
              run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
              read: (path) => $.fs.read(path),
              write: (path, text) => $.fs.write(path, text),
              mtime: async (path) => (await $.fs.stat(path).catch(() => undefined))?.mtimeMs,
              now,
              sleep,
              submit,
              starting,
              status,
              log,
            },
            dir,
            undefined,
            undefined,
            unconfirmed,
          ),
        sleep,
        clearStatus: () => status(undefined),
        log,
      },
      undefined,
      before?.unconfirmed,
    );
    return started;
  });

  // A subagent's run raises no `turn.start`; its `turn.complete` and tool calls carry its `agentId`.
  on("turn.start", async (_$, e, next) => {
    handover.started();
    return next(e);
  });

  on("turn.complete", async (_$, e, next) => {
    const r = await next(e);
    if (e.agentId === undefined) handover.ended();
    return r;
  });

  on("tool.call", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId !== undefined || r.deny !== undefined) return r;
    const lines = handover.take();
    if (lines.length === 0) return r;
    $.ui.log(`starbridge: handed ${lines.length} answer(s) with the ${e.tool} result`, {
      to: "debug",
    });
    return { ...r, context: [...(r.context ?? []), ...lines] };
  });

  // After a /clear or a /resume the process goes on under another session id, with no
  // `session.start`, and the loop reads the id each step. Only the end of the process stops it.
  on("session.end", async (_$, e, next) => {
    handover.ended();
    if (e.reason !== "clear" && e.reason !== "resume") {
      await loop?.end();
      loop = undefined;
    }
    return next(e);
  });
};
