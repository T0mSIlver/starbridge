/**
 * Picks the session's answer loop: `AgentLoop` (agent.ts) while the machine's agent answers on
 * its socket, else `Poller` (poller.ts), which runs the CLI as before the agent existed. It
 * checks for the agent every `probeMs` while the CLI path runs, and goes back to the CLI path
 * when the agent stops answering.
 */

import type { AgentLoop } from "./agent.ts";
import type { Poller } from "./poller.ts";

/** Entry points of a run that ends with its last turn: `claude -p` and Agent SDK scripts. */
const ONE_SHOT = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);

/** The Agent SDK's entry points, which a host may also run for a person (#2100). */
export const SDK_ENTRYPOINTS = new Set(["sdk-ts", "sdk-py"]);

/**
 * T3 Code's MCP tools, which it allows in every Claude Code session it runs: all of them
 * (`mcp__t3-code__*`), or the read-only ones by name.
 */
const T3_CODE_TOOLS = /(?:^|[\s,])mcp__t3-code__/;

/**
 * Whether a session gets an answer loop: one under the REPL, or one a host such as Claude
 * desktop's Code tab or an IDE keeps open for a person (#863). The engine calls those not
 * interactive, as it does a `claude -p` run, so the host's `CLAUDE_CODE_ENTRYPOINT` tells them
 * apart; a run with none set is `claude -p`'s own. T3 Code runs Claude Code through the Agent
 * SDK and sets no entry point of its own, but keeps the session open between turns and shows a
 * turn a plugin starts, so a session whose arguments (`args`, the Claude Code process's command
 * line) allow T3 Code's tools gets one too (#2100).
 */
export function wantsLoop(
  isInteractive: boolean,
  entrypoint: string | undefined,
  args?: string,
): boolean {
  if (isInteractive) return true;
  if (!entrypoint) return false;
  if (!ONE_SHOT.has(entrypoint)) return true;
  return SDK_ENTRYPOINTS.has(entrypoint) && !!args && T3_CODE_TOOLS.test(args);
}

/**
 * The command line of the Claude Code process, the parent of the shell `run` starts; undefined
 * when it cannot be read. Linux has `/proc`, macOS only `ps`.
 */
export async function ownArgs(
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>,
): Promise<string | undefined> {
  try {
    const r = await run([
      "sh",
      "-c",
      `tr '\\0' ' ' < /proc/$PPID/cmdline 2>/dev/null || ps -ww -o args= -p $PPID`,
    ]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

export interface Paths {
  /** True when an agent answers `GET /v1/status` with a 2xx. */
  agentUp(): Promise<boolean>;
  agent(unconfirmed: Set<string>): AgentLoop;
  poller(unconfirmed: Set<string>): Poller;
  sleep(ms: number): Promise<void>;
  /** Clears the status line: each loop clears only the errors it showed itself. */
  clearStatus(): void;
  log(text: string): void;
}

export class Switch {
  private stopped = false;
  private agent: AgentLoop | undefined;
  private poller: Poller | undefined;
  /** The last agent loop, for its `bye` at the end of the session. */
  private lastAgent: AgentLoop | undefined;
  /** Resolves when the loop has ended. */
  readonly done: Promise<void>;

  constructor(
    private readonly paths: Paths,
    private readonly probeMs = 30_000,
    /**
     * Shared by both loops, so a line submitted before a switch is not submitted again after; and
     * with the loop that replaces this one, which only confirms it then (#1337).
     */
    readonly unconfirmed = new Set<string>(),
  ) {
    // Nothing awaits a loop that ended before `stop`: a rejection would take the harness down (#1365).
    this.done = this.loop().catch((e) => {
      try {
        this.paths.log(`starbridge: the answer loop stopped: ${(e as Error).message}`);
      } catch {}
    });
  }

  /** Which loop runs now, for tests and the debug log. */
  get mode(): "agent" | "cli" | undefined {
    return this.agent ? "agent" : this.poller ? "cli" : undefined;
  }

  /**
   * Confirms through the loop that runs now the lines among `acks` still due to this session, and
   * returns those; none when no loop runs or the call fails.
   */
  async claim(acks: string[]): Promise<string[]> {
    try {
      return (await (this.agent ?? this.poller)?.claim(acks)) ?? [];
    } catch {
      return [];
    }
  }

  /** Ends the loop; the Poller gives up its lease at once. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.agent?.stop();
    await this.poller?.stop();
  }

  /**
   * Stops, and tells the agent this session ended. Waits at most 2 s for that: a hung agent
   * must not hold up the session's exit, and a missed `bye` only leaves a stale entry in `status`.
   */
  async end(): Promise<void> {
    await this.stop();
    const bye = this.lastAgent?.bye();
    if (bye) await Promise.race([bye, this.paths.sleep(2_000)]);
  }

  private async loop() {
    while (!this.stopped) {
      if (await this.up()) {
        this.paths.log("starbridge: answers through the agent");
        this.paths.clearStatus();
        const agent = this.paths.agent(this.unconfirmed);
        this.agent = agent;
        this.lastAgent = agent;
        // `stop` may have come while the probe ran, before `this.agent` was set.
        if (this.stopped) agent.stop();
        await agent.run();
        this.agent = undefined;
        continue;
      }
      if (this.stopped) return;
      this.paths.log("starbridge: no agent; answers through the CLI");
      this.paths.clearStatus();
      const poller = this.paths.poller(this.unconfirmed);
      this.poller = poller;
      while (!this.stopped) {
        await this.paths.sleep(this.probeMs);
        if (!this.stopped && (await this.up())) break;
      }
      // Lets the step in progress finish and confirm what it submitted.
      await poller.stop();
      await poller.done;
      this.poller = undefined;
    }
  }

  private async up(): Promise<boolean> {
    try {
      return await this.paths.agentUp();
    } catch {
      return false;
    }
  }
}
