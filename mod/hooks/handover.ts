import type { Line } from "./agent.ts";

/**
 * When an answer reaches the agent (#1484, #1584). Claude Code starts a prompt the mod submits only
 * after the running turn, which can be minutes away, and the turn meanwhile works without the
 * owner's word. So while the main agent's turn runs, its next tool result carries the answer as
 * context, waiting or not, as Claude Code does with a message typed during a turn. An answer that
 * comes after the turn's last tool call goes as a prompt once the turn ends. The mod's own
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
   * The loops' submit. Submits `lines` as one prompt with `enter` while no turn runs. During one,
   * keeps them, with the acks that confirm them, for the next tool call, and takes none: they
   * stay unconfirmed and come back in the next poll. A line a tool result already carried counts
   * as taken without a second submit. Returns the acks taken, with those `enter` reports it took.
   */
  async submit(
    lines: Line[],
    enter: (lines: Line[]) => string[] | Promise<string[]>,
  ): Promise<string[]> {
    const carried = lines.filter((l) => this.handed.delete(l.text));
    const rest = lines.filter((l) => !carried.includes(l));
    if (this.running) {
      for (const l of rest) this.next.set(l.text, l.ack);
      return carried.map((l) => l.ack);
    }
    const entered = rest.length > 0 ? await enter(rest) : [];
    return [...carried.map((l) => l.ack), ...entered];
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
