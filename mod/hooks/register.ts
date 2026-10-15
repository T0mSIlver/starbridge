import type { Register } from "claude-code";
import {
  AgentLoop,
  HEADERS,
  isPortFile,
  type Line,
  PROOF_HEADER,
  pidRuns,
  portTarget,
  signCall,
  socketPath,
} from "./agent.ts";
import { Handover } from "./handover.ts";
import { configDir, Poller } from "./poller.ts";
import { Sent, sessionElsewhere } from "./sent.ts";
import { forParent, tagAsk, toSubagents, untagAsk } from "./subagent.ts";
import { Switch, wantsLoop } from "./switch.ts";

/**
 * Starts the answer loop in each session a person keeps open (`wantsLoop`): through the machine's agent when it runs
 * (agent.ts), else through the CLI (poller.ts); switch.ts picks. A hot reload loads this module
 * afresh: the old loop dies with the old module, and `session.start` starts a new one. While the
 * main agent's turn runs, an answer goes out with its next tool result instead (handover.ts).
 * An answer submitted as a prompt stays on record until its turn starts, so a process that exits
 * first does not lose it (sent.ts).
 */
/**
 * Exits 0 when "$1" is a file owned by this user or root that neither its group nor others may
 * write: what `ownedFile` (node.ts) checks, for a host that reads no owner or mode.
 */
const OWNED =
  '[ -n "$(find -L "$1" -prune -type f \\( -user "$(id -u)" -o -user 0 \\) ! -perm -020 ! -perm -002 2>/dev/null)" ]';

export const register: Register = (on) => {
  let loop: Switch | undefined;
  /** Prompts submitted whose turn has not started. */
  let waiting = 0;
  // `$.prompt.submit` resolves when the prompt's turn starts: mid-turn, once the running one ends.
  const track = (submitted: Promise<unknown>) => {
    waiting++;
    const started = () => void waiting--;
    submitted.then(started, started);
    return submitted;
  };
  const handover = new Handover();
  let sent: Sent | undefined;
  /** Answers a subagent could not take: they go to the parent from then on (#1702). */
  const failed = new Set<string>();
  /** When each subagent's last tool call ended: a message sent before then, it has read. */
  const roundEnded = new Map<string, number>();

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
      CLAUDE_CONFIG_DIR: await $.env.get("CLAUDE_CONFIG_DIR"),
      XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
      XDG_RUNTIME_DIR: await $.env.get("XDG_RUNTIME_DIR"),
      HOME: await $.env.get("HOME"),
      USERPROFILE: await $.env.get("USERPROFILE"),
      OS: await $.env.get("OS"),
    };
    const dir = configDir(env);
    const socket = socketPath(env);
    // Kept across a hot reload, and new in each process (sent.ts); undefined on a build that
    // lacks `$.state`.
    const proc = { plugin: "starbridge-mod", key: "process" } as const;
    let token: string | undefined;
    try {
      token = (await $.state.get(proc)).value;
      if (!token) {
        token = crypto.randomUUID();
        await $.state.set(proc, token);
      }
    } catch {
      token = undefined;
    }
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
    const sessionId = () => $.session.id();
    const now = () => $.clock.now();
    const sleep = (ms: number) => $.clock.sleep(ms);
    const records = new Sent(
      {
        sessionId,
        read: async (path) => ((await $.fs.exists(path)) ? $.fs.read(path) : undefined),
        write: (path, text) => $.fs.write(path, text),
        now,
        submit: (text) => track($.prompt.submit({ text })),
        elsewhere: async (session) => {
          // Claude Code's own pid, as the parent of the shell it runs; Windows has no `sh`.
          if (env.OS === "Windows_NT") return false;
          const own = Number(
            (await $.process.run(["sh", "-c", "echo $PPID"], { timeoutMs: 10_000 })).stdout.trim(),
          );
          if (!own) return false;
          return sessionElsewhere(
            session,
            own,
            { list: (path) => $.fs.list(path), read: (path) => $.fs.read(path) },
            `${env.CLAUDE_CONFIG_DIR || `${env.HOME}/.claude`}/sessions`,
            (pid) => pidRuns(pid, false, (argv) => $.process.run(argv, { timeoutMs: 10_000 })),
          );
        },
        log,
      },
      dir,
      token,
    );
    sent = records;
    /** Whether subagent `agentId` runs now; when unsure, it does. */
    const running = async (agentId: string) => {
      try {
        const status = (await $.agent.list()).find((a) => a.id === agentId)?.status;
        return status === undefined || ["pending", "running", "waiting"].includes(status);
      } catch {
        return true;
      }
    };
    // A subagent's answers go to it, whatever the main agent does (#1702).
    const submit = async (lines: Line[]) => {
      const me = await sessionId();
      const { taken, rest } = await toSubagents(
        lines,
        async (agentId, group, text) => {
          const send = () => $.session.send({ to: { agentId }, text });
          // A subagent that ended is resumed with the message as its prompt, which its transcript
          // keeps; one that runs holds it in memory until its next tool round.
          if (!(await running(agentId))) return send();
          return records.toAgent(
            agentId,
            group.map((l) => forParent(l, agentId)),
            send,
            () => running(agentId),
          );
        },
        log,
        failed,
      );
      // A /clear or /resume during the sends: the rest waits, unconfirmed, for session `me`.
      if (rest.length > 0 && (await sessionId()) !== me) return taken;
      const parent =
        rest.length > 0 ? await handover.submit(rest, (left) => records.send(left)) : [];
      return [...taken, ...parent];
    };
    const starting = () => waiting > 0;
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
              // The mod's host reads no owner or mode: find does, as plugin/hooks/cli.sh. Windows
              // has no `sh`, and keeps owners in ACLs: there, as `ownedFile`, a file.
              owned: async (path) =>
                env.OS === "Windows_NT"
                  ? (await $.fs.stat(path).catch(() => undefined))?.kind === "file"
                  : (
                      await $.process
                        .run(["sh", "-c", OWNED, "sh", path], { timeoutMs: 10_000 })
                        .catch(() => undefined)
                    )?.exitCode === 0,
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
    void records.recover().catch((e) => log(`starbridge: ${(e as Error).message}`));
    return started;
  });

  // A subagent's run raises no `turn.start`; its `turn.complete` and tool calls carry its `agentId`.
  on("turn.start", async (_$, e, next) => {
    handover.started();
    await sent?.started(e.text).catch(() => undefined);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId !== undefined) {
      const agent = e.agentId;
      const ended = roundEnded.get(agent);
      if (ended !== undefined) void sent?.read(agent, ended).catch(() => undefined);
      // A message that came after its last round waits for another one, which a subagent that
      // finished never runs: the parent gets it instead (#1729).
      void (async () => {
        const list = () => $.agent.list();
        if (!sent || !(await finished(list, (ms) => $.clock.sleep(ms), agent))) return;
        roundEnded.delete(agent);
        if (await sent.finished(agent, ended)) await sent.recover();
      })().catch(() => undefined);
    } else {
      handover.ended();
      // After a `/resume`, or a submit that failed.
      void sent?.recover().catch(() => undefined);
    }
    return r;
  });

  on("tool.call", async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agent = e.agentId;
      // A new round: the subagent read every message sent before its last one ended.
      const ended = roundEnded.get(agent);
      if (ended !== undefined) void sent?.read(agent, ended).catch(() => undefined);
      // The CLI keeps which subagent asked, so its answer goes back there (#1702).
      const command =
        e.tool === "Bash" && typeof e.command === "string" ? tagAsk(e.command, agent) : undefined;
      const r = await next(command !== undefined && command !== e.command ? { ...e, command } : e);
      roundEnded.set(agent, await $.clock.now());
      return r;
    }
    const r = await next(e);
    if (r.deny !== undefined) return r;
    const lines = await handover.take((acks) => loop?.claim(acks) ?? Promise.resolve([]));
    if (lines.length === 0) return r;
    $.ui.log(`starbridge: handed ${lines.length} answer(s) with the ${e.tool} result`, {
      to: "debug",
    });
    return { ...r, context: [...(r.context ?? []), ...lines] };
  });

  // The tag `tool.call` adds is not the subagent's, so the rules judge the command it wrote: where
  // they would ask about the tagged one, the verdict on the untagged one stands (#1702).
  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    const input = e.input as { command?: unknown } | undefined;
    if (verdict.decision !== "ask" || verdict.hook !== undefined) return verdict;
    if (e.tool !== "Bash" || typeof input?.command !== "string") return verdict;
    const command = untagAsk(input.command);
    if (command === input.command) return verdict;
    const plain = await $.tool.check({ tool: "Bash", input: { ...input, command } });
    return plain.decision === "ask" ? verdict : plain;
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

/** A subagent's statuses once it runs no more rounds. */
const DONE = ["completed", "failed", "killed"];

/**
 * Whether subagent `agentId`, whose turn just completed, runs no more rounds: done, or no longer
 * listed. The engine may mark it a moment after its `turn.complete`, so it looks twice. An idle
 * teammate wakes for a message, so it has not; nor, when the list cannot be read, has any.
 */
export async function finished(
  list: () => Promise<{ id: string; status: string }[]>,
  sleep: (ms: number) => Promise<void>,
  agentId: string,
): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(2000);
    const agents = await list().catch(() => undefined);
    if (!agents) return false;
    const status = agents.find((a) => a.id === agentId)?.status;
    if (status === undefined || DONE.includes(status)) return true;
  }
  return false;
}
