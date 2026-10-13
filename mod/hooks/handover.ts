/**
 * When an answer reaches the agent (#1484). Claude Code starts a prompt the mod submits only after
 * the running turn, which can be minutes away. An agent that marked the decision waiting needs the
 * answer now: while the main agent's turn runs, its next tool result carries it as context. Any
 * other answer waits for the turn to end, so it does not pull the agent off its task: the loops
 * leave it unconfirmed, and the first poll after the turn submits it. The mod's own
 * `prompt.submit` hook never sees its own prompts, so it could not drop a second copy: a line goes
 * out one way only.
 */
export class Handover {
  private running = false;
  /** Lines for the main agent's next tool call. */
  private readonly next = new Set<string>();
  /** Lines handed over in a tool result that the loop has not confirmed yet. */
  private readonly handed = new Set<string>();

  /**
   * The loops' submit. Submits `text` with `enter` while no turn runs. During one, returns false,
   * so the line stays unconfirmed and comes back in the next poll, and keeps a `waiting` line for
   * the next tool call. A line a tool result already carried returns true without a second submit,
   * and the loop confirms it.
   */
  submit(text: string, waiting: boolean, enter: (text: string) => void): boolean {
    if (this.handed.delete(text)) return true;
    if (this.running) {
      if (waiting) this.next.add(text);
      return false;
    }
    enter(text);
    return true;
  }

  /** The main agent's turn started. */
  started() {
    this.running = true;
  }

  /** The lines a main-agent tool result carries; they count as handed over. */
  take(): string[] {
    const lines = [...this.next];
    this.next.clear();
    for (const line of lines) this.handed.add(line);
    return lines;
  }

  /**
   * No turn runs: the main agent's turn ended, or the session started or ended. Lines kept for a
   * tool call are still unconfirmed, so the next poll submits them, for the session that asked.
   */
  ended() {
    this.running = false;
    this.next.clear();
  }
}
