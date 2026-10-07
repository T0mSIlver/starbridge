/**
 * `starbridge run --title T --reason R -- <command>`: runs the command with its output passed
 * through unchanged, and reports it to every device as a `run` item: when it starts, as its output
 * shows progress, and when it exits. It exits with the command's own code, and a report that
 * fails never stops the command.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import type { Writable } from "node:stream";
import {
  type MachineKind,
  ProtocolError,
  parseWith,
  RUN_HEARTBEAT_MS,
  Run,
  type RunProgress,
  type SessionLink,
  seal,
} from "@starbridge/protocol";
import { AgentClient, AgentError, NoAgent } from "./agent/client";
import {
  type Ctx,
  devices,
  iso,
  machineKind,
  refreshDirectory,
  type Session,
  session,
  signedHead,
  UsageError,
} from "./context";
import { resolveSource } from "./decisions";
import { killTree, resolveCommand, spawnable } from "./platform";

/** Progress is reported at most this often; a heartbeat comes every RUN_HEARTBEAT_MS. */
export const PROGRESS_MS = 10_000;
/** After the command exits, how long the last report may take before the CLI exits anyway. */
const FINAL_MS = 15_000;
/** After Ctrl-C or SIGTERM, how long the command gets before the CLI sends it SIGTERM. */
const GRACE_MS = 1_000;
/** The shell's code for a command that could not be found or started. */
const EXIT_NOT_FOUND = 127;

/** What a run update says, before the machine adds its name and the recipients. */
export interface RunInput {
  id: string;
  title: string;
  reason: string;
  startedAt: string;
  at: string;
  progress?: RunProgress;
  exit?: { code: number; at: string };
  project: string;
  session: string;
  sessionTitle?: string;
  links?: SessionLink[];
}

export function buildRun(
  input: RunInput,
  machine: string,
  to: string[],
  kind: { machineKind?: MachineKind } = {},
): Run {
  const run = {
    v: 1 as const,
    id: input.id,
    to,
    title: input.title,
    reason: input.reason,
    source: {
      machine,
      ...kind,
      project: input.project,
      session: input.session,
      ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
      ...(input.links && input.links.length > 0 ? { links: input.links } : {}),
    },
    startedAt: input.startedAt,
    at: input.at,
    ...(input.progress ? { progress: input.progress } : {}),
    ...(input.exit ? { exit: input.exit } : {}),
  };
  try {
    return parseWith(Run, run);
  } catch (e) {
    throw e instanceof ProtocolError ? new UsageError(`bad run: ${e.message}`) : e;
  }
}

/** Seals a run update to every active device and posts it; the agent and the CLI share this. */
export async function postRun(ctx: Ctx, s: Session, input: RunInput): Promise<Run> {
  const dir = await refreshDirectory(ctx, s);
  const to = devices(ctx, dir);
  const run = {
    ...buildRun(
      input,
      s.machine.name,
      to.map((d) => d.id),
      machineKind(ctx),
    ),
    dir: signedHead(dir),
  };
  const signer = { id: s.machine.id, signKey: s.keys.sign.privateKey };
  await s.api.postItem(seal("run", run, signer, to));
  return run;
}

// --- Progress in the output ----------------------------------------------------

// OSC 9;4;<state>;<percent> ended by BEL or ST: 1 sets, 2 error, 4 paused keep the value; 0
// removes it and 3 is indeterminate. `[3/7]` counts steps. `42%` or `42.5 %` is a percent.
const PROGRESS_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 9;4 starts with ESC, ends with BEL or ST.
  /\x1b\]9;4;([0-4])(?:;(\d{1,3}))?(?:\x07|\x1b\\)|\[\s*(\d+)\s*\/\s*(\d+)\s*\]|(?<![\d.])(\d{1,3}(?:\.\d+)?)\s?%/g;
/** Kept from the end of a chunk so a sequence split across two chunks still matches. */
const CARRY = 64;

/**
 * Reads progress out of one output stream. `feed` takes raw chunks and returns what the last
 * progress in them says: a value, `null` when the output cleared it, or `undefined` when the
 * chunk said nothing.
 */
export class ProgressParser {
  private carry = "";

  feed(chunk: Buffer | string): RunProgress | null | undefined {
    // latin1 maps each byte to one character: the patterns are ASCII, and nothing splits.
    const text = this.carry + (typeof chunk === "string" ? chunk : chunk.toString("latin1"));
    let found: RunProgress | null | undefined;
    let end = 0;
    for (const m of text.matchAll(PROGRESS_RE)) {
      const p = progressOf(m);
      if (p !== undefined) found = p;
      end = (m.index ?? 0) + m[0].length;
    }
    // Keep only what follows the last match, so nothing is read twice.
    this.carry = text.slice(Math.max(end, text.length - CARRY));
    return found;
  }
}

function progressOf(m: RegExpMatchArray): RunProgress | null | undefined {
  const [, state, oscValue, done, total, percent] = m;
  if (state !== undefined) {
    if (state === "0" || state === "3") return null;
    const v = Number(oscValue ?? Number.NaN);
    return v >= 0 && v <= 100 ? { done: v, total: 100, unit: "percent" } : undefined;
  }
  if (done !== undefined && total !== undefined) {
    const d = Number(done);
    const t = Number(total);
    return t >= 1 && d <= t ? { done: d, total: t, unit: "step" } : undefined;
  }
  const v = Math.floor(Number(percent));
  return v >= 0 && v <= 100 ? { done: v, total: 100, unit: "percent" } : undefined;
}

// --- Reporting -------------------------------------------------------------------

/** Posts one update: through the agent when one runs, else to the server directly. */
export type Poster = (input: RunInput) => Promise<void>;

/**
 * Each update replaces the last under the run's id, so whichever path posted the previous one,
 * falling back can never post anything twice that matters.
 */
export function makePoster(ctx: Ctx): Poster {
  let direct: Session | undefined;
  return async (input) => {
    const agent = AgentClient.for(ctx);
    if (agent) {
      try {
        await agent.call("POST", "/v1/runs", { run: input });
        return;
      } catch (e) {
        // No agent, or another API revision: it did nothing, so the server directly.
        const skipped = e instanceof NoAgent || (e instanceof AgentError && e.status === 426);
        if (!skipped) throw e;
      }
    }
    direct ??= session(ctx);
    await postRun(ctx, direct, input);
  };
}

/**
 * Sends a run's updates one at a time: the start at once, progress at most every PROGRESS_MS, a
 * heartbeat when RUN_HEARTBEAT_MS passed with no update, and the exit. An update asked for while
 * one is in flight replaces any waiting one, so only the latest state goes out.
 */
export class Reporter {
  private progress: RunProgress | undefined;
  private exit: { code: number; at: string } | undefined;
  private lastPost = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warned = false;
  private off = false;

  constructor(
    private readonly base: Omit<RunInput, "at" | "progress" | "exit">,
    private readonly post: Poster,
    private readonly ctx: Ctx,
    private readonly timing = { progressMs: PROGRESS_MS, heartbeatMs: RUN_HEARTBEAT_MS },
  ) {}

  start() {
    this.send();
  }

  /** The output's latest progress; `null` clears it. */
  update(p: RunProgress | null) {
    const next = p ?? undefined;
    if (JSON.stringify(next) === JSON.stringify(this.progress)) return;
    this.progress = next;
    this.schedule(this.timing.progressMs);
  }

  /** Posts the exit and resolves once it is sent, or after FINAL_MS. */
  async finish(code: number): Promise<void> {
    this.exit = { code, at: iso(this.ctx.now()) };
    clearTimeout(this.timer);
    this.send();
    const settled = (async () => {
      while (this.inflight) await this.inflight;
    })();
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settled, new Promise<void>((r) => (t = setTimeout(r, FINAL_MS)))]);
    clearTimeout(t);
  }

  /** Posts once `gap` has passed since the last post; a heartbeat stands in for silence. */
  private schedule(gap: number) {
    if (this.off || this.exit) return;
    clearTimeout(this.timer);
    const wait = Math.max(0, this.lastPost + gap - this.ctx.now().getTime());
    this.timer = setTimeout(() => this.send(), wait);
  }

  private send() {
    if (this.off) return;
    clearTimeout(this.timer);
    if (this.inflight) {
      this.queued = true;
      return;
    }
    const input: RunInput = {
      ...this.base,
      at: iso(this.ctx.now()),
      ...(this.progress ? { progress: this.progress } : {}),
      ...(this.exit ? { exit: this.exit } : {}),
    };
    this.lastPost = this.ctx.now().getTime();
    this.inflight = this.post(input)
      .catch((e: Error) => {
        // Not paired, or a bad title: no later update can fare better.
        if (e instanceof UsageError) this.off = true;
        if (!this.warned || this.off)
          this.ctx.err(
            `starbridge: the run was not reported: ${e.message}${this.ctx.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? ". Codex's sandbox has no network: runs reach your devices when Codex runs the command outside it" : ""}`,
          );
        this.warned = true;
      })
      .finally(() => {
        this.inflight = undefined;
        if (this.queued) {
          this.queued = false;
          this.send();
        } else this.schedule(this.timing.heartbeatMs);
      });
  }
}

// --- The command -------------------------------------------------------------------

export interface RunOpts {
  title?: string;
  reason?: string;
  command: string[];
  /** Where the command's output goes: this process's own streams outside tests. */
  stdout?: Writable;
  stderr?: Writable;
  /** How updates leave: through the agent or to the server (`makePoster`). */
  post?: Poster;
}

/** Sends each chunk on unchanged, pausing the command's output while `to` is full. */
function pass(
  from: NodeJS.ReadableStream | null,
  to: Writable,
  parse: ProgressParser,
  on: (p: RunProgress | null) => void,
) {
  from?.on("data", (chunk: Buffer) => {
    if (!to.write(chunk)) {
      from.pause();
      to.once("drain", () => from.resume());
    }
    const p = parse.feed(chunk);
    if (p !== undefined) on(p);
  });
}

export async function runCommand(ctx: Ctx, opts: RunOpts): Promise<number> {
  const title = opts.title?.trim();
  const reason = opts.reason?.trim();
  if (!title) throw new UsageError('run needs --title: what the owner sees, e.g. "Mac e2e"');
  if (!reason)
    throw new UsageError(
      'run needs --reason: why the owner hears of it, e.g. "uses your session and keyboard"',
    );
  if (title.length > 100) throw new UsageError("--title takes at most 100 characters");
  if (reason.length > 200) throw new UsageError("--reason takes at most 200 characters");
  const [bin, ...args] = opts.command;
  if (!bin) throw new UsageError("run needs the command after --: starbridge run ... -- <command>");

  // On Windows `npm` is `npm.cmd`, which spawn finds only by its full name.
  let start: ReturnType<typeof spawnable>;
  try {
    start = spawnable(resolveCommand(ctx.env, bin) ?? bin, args, ctx.env);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }

  const source = resolveSource({}, ctx.env, process.cwd());
  const reporter = new Reporter(
    {
      id: `r_${randomBytes(12).toString("base64url")}`,
      title,
      reason,
      startedAt: iso(ctx.now()),
      project: source.project,
      session: source.session,
      ...(source.sessionTitle ? { sessionTitle: source.sessionTitle } : {}),
      ...(source.sessionLinks.length > 0 ? { links: source.sessionLinks } : {}),
    },
    opts.post ?? makePoster(ctx),
    ctx,
  );

  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const child: ChildProcess = spawn(start.file, start.args, {
    stdio: ["inherit", "pipe", "pipe"],
    windowsVerbatimArguments: start.windowsVerbatimArguments,
  });
  reporter.start();
  const update = (p: RunProgress | null) => reporter.update(p);
  pass(child.stdout, stdout, new ProgressParser(), update);
  pass(child.stderr, stderr, new ProgressParser(), update);

  // Ctrl-C at a terminal reaches the command itself; SIGTERM to this process may not.
  let grace: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    grace = setTimeout(() => killTree(child, "SIGTERM"), GRACE_MS);
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  const code = await new Promise<number>((resolve) => {
    child.on("error", (e: NodeJS.ErrnoException) => {
      ctx.err(`starbridge: ${bin}: ${e.code === "ENOENT" ? "command not found" : e.message}`);
      resolve(EXIT_NOT_FOUND);
    });
    child.on("close", (exit, signal) => {
      if (exit !== null) resolve(exit);
      else resolve(128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
  clearTimeout(grace);
  ctx.signal?.removeEventListener("abort", onAbort);
  await reporter.finish(code);
  return code;
}
