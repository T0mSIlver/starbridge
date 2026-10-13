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
  /** Lines for the main agent's next tool call, by their line, with what confirms each. */
  private readonly next = new Map<string, string>();
  /**
   * Lines a tool result carried, confirmed then: a loop that read one before that, and submits it
   * now, finds it here and submits nothing.
   */
  private readonly handed = new Set<string>();

  /**
   * The loops' submit. Submits `text` with `enter` while no turn runs. During one, returns false,
   * so the line stays unconfirmed and comes back in the next poll, and keeps a `waiting` line, and
   * the `ack` that confirms it, for the next tool call. A line a tool result already carried
   * returns true without a second submit.
   */
  submit(text: string, ack: string, waiting: boolean, enter: (text: string) => void): boolean {
    if (this.handed.delete(text)) return true;
    if (this.running) {
      if (waiting) this.next.set(text, ack);
      return false;
    }
    enter(text);
    return true;
  }

  /** The main agent's turn started. */
  started() {
    this.running = true;
  }

  /**
   * The lines a main-agent tool result carries. `claim` confirms them first and returns the acks
   * still due: a line a `wait` or `waiting` printed meanwhile goes no further, and one confirmed
   * here is not handed over again after a reload or a restart.
   */
  async take(claim: (acks: string[]) => Promise<string[]>): Promise<string[]> {
    if (this.next.size === 0) return [];
    const lines = [...this.next];
    this.next.clear();
    const due = new Set(await claim(lines.map(([, ack]) => ack)));
    const out = lines.filter(([, ack]) => due.has(ack)).map(([line]) => line);
    for (const line of out) this.handed.add(line);
    return out;
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
