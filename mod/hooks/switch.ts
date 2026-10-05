/**
 * Picks the session's answer loop: `AgentLoop` (agent.ts) while the machine's agent answers on
 * its socket, else `Poller` (poller.ts), which runs the CLI as before the agent existed. It
 * checks for the agent every `probeMs` while the CLI path runs, and goes back to the CLI path
 * when the agent stops answering.
 */

import type { AgentLoop } from "./agent.ts";
import type { Poller } from "./poller.ts";

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
  /** Shared by both loops, so a line submitted before a switch is not submitted again after. */
  private readonly unconfirmed = new Set<string>();
  /** Resolves when the loop has ended. */
  readonly done: Promise<void>;

  constructor(
    private readonly paths: Paths,
    private readonly probeMs = 30_000,
  ) {
    this.done = this.loop();
  }

  /** Which loop runs now, for tests and the debug log. */
  get mode(): "agent" | "cli" | undefined {
    return this.agent ? "agent" : this.poller ? "cli" : undefined;
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
