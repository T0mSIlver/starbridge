/**
 * Hands an answer to the agent while its turn runs (#1484). Claude Code starts a prompt the mod
 * submits only after the running turn, which can be minutes away. So while the main agent's turn
 * runs, the loops leave each line here instead: the agent's next tool result carries it as
 * context, and the end of the turn submits what no tool call took. The mod's own `prompt.submit`
 * hook never sees its own prompts, so it could not drop a second copy: a line goes out one way only.
 */
export class Handover {
  private running = false;
  /** Lines waiting for the main agent's next tool call or the end of its turn. */
  private readonly held = new Set<string>();
  /** Lines handed over that the loop has not confirmed yet. */
  private readonly handed = new Set<string>();

  /**
   * The loops' submit. Submits `text` with `enter` while no turn runs; during one, holds it and
   * returns false, so the line stays unconfirmed and comes back in the next poll. A line already
   * handed over returns true without a second submit, and the loop confirms it.
   */
  submit(text: string, enter: (text: string) => void): boolean {
    if (this.handed.delete(text)) return true;
    if (this.running) {
      this.held.add(text);
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
    const lines = [...this.held];
    this.held.clear();
    for (const line of lines) this.handed.add(line);
    return lines;
  }

  /** The main agent's turn ended: submits what no tool call took. */
  ended(enter: (text: string) => void) {
    this.running = false;
    for (const line of this.take()) enter(line);
  }
}
