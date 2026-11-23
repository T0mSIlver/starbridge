import type { Line } from "./agent.ts";

/**
 * The answers a run that ends with its turn (`pi -p`, `opencode run`) gets, which the run must
 * have read before the loop confirms them (#2280). Pi and opencode confirm a line the moment it
 * is submitted, which in such a run loses it if the run exits right after: `wait` would no longer
 * print it. So a submitted line stays unconfirmed, and goes on only once the harness shows the
 * agent has it: the line is in the context Pi, or the messages opencode, is about to send to the
 * model. Claude Code's `Handover` does the same for `claude -p` (#2258).
 *
 * A line is submitted only while the turn runs: an idle session would start a turn of its own
 * with it, which spends quota unwatched. One that misses the turn stays unconfirmed for `wait`.
 */
export class Unread {
  private running = false;
  /** Counts the turn's starts and ends, so a submit can tell its turn ended meanwhile. */
  private generation = 0;
  /** Lines submitted and not yet read, by their text, with the ack that confirms each. */
  private readonly sent = new Map<string, string>();
  /** Lines the agent read whose confirmation failed: the loop's next poll confirms them. */
  private readonly read = new Map<string, string>();
  /**
   * Lines the agent read, kept for the run: a poll that came back after the confirmation, with
   * the line in its answer, must not submit it again.
   */
  private readonly done = new Set<string>();

  /** `dropped` hears the lines still unread when the turn or the session ends. */
  constructor(private readonly dropped: (texts: string[]) => void = () => {}) {}

  /** Whether a submitted line waits to be read. */
  get pending() {
    return this.sent.size > 0;
  }

  /** The turn started or ended. A line still unread when it ends stays unconfirmed. */
  turn(running: boolean) {
    if (running !== this.running) this.generation++;
    this.running = running;
    if (!running) this.drop();
  }

  private drop() {
    const texts = [...this.sent.keys()];
    this.sent.clear();
    if (texts.length > 0) this.dropped(texts);
  }

  /**
   * The loops' submit. While the turn runs, `send` submits the lines not sent before, as one
   * message, and returns those the harness took; none is confirmed here. Returns the acks of
   * lines already read whose confirmation failed.
   */
  async submit(
    lines: Line[],
    /** `live` says whether the turn this submit began in still runs: check it right before sending. */
    send: (lines: Line[], live: () => boolean) => Line[] | Promise<Line[]>,
  ) {
    const carried = lines.filter((l) => this.read.has(l.text));
    for (const l of carried) this.read.delete(l.text);
    if (this.running) {
      const fresh = lines.filter(
        (l) => !carried.includes(l) && !this.sent.has(l.text) && !this.done.has(l.text),
      );
      // Recorded first: the harness may show the message before its submit returns.
      for (const l of fresh) this.sent.set(l.text, l.ack);
      if (fresh.length > 0) {
        const generation = this.generation;
        const live = () => this.running && this.generation === generation;
        const took = new Set((await send(fresh, live)).map((l) => l.text));
        for (const l of fresh) if (!took.has(l.text)) this.sent.delete(l.text);
      }
    }
    return carried.map((l) => l.ack);
  }

  /**
   * The agent has `text` in what it is about to read. Confirms, through `claim`, the sent lines
   * it holds: a line a `wait` printed first is not confirmed twice. One whose confirmation fails
   * is confirmed by the loop's next poll.
   */
  async entered(text: string, claim: (acks: string[]) => Promise<string[]>) {
    const hits = [...this.sent].filter(([line]) => text.includes(line));
    if (hits.length === 0) return;
    for (const [line, ack] of hits) {
      this.sent.delete(line);
      this.done.add(line);
      this.read.set(line, ack);
    }
    const done = new Set(await claim(hits.map(([, ack]) => ack)));
    for (const [line, ack] of hits) if (done.has(ack)) this.read.delete(line);
  }

  /** The session ended. */
  ended() {
    this.running = false;
    this.generation++;
    this.drop();
    this.read.clear();
    this.done.clear();
  }
}
