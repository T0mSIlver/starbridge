/**
 * Answers the mod submitted as prompts, kept until their turn starts (#1517).
 *
 * The loops confirm a line to the CLI or the agent as soon as they submit it, so a `wait` or
 * `waiting` never prints an answer already queued as a prompt. But Claude Code keeps a queued
 * prompt in memory only: one still waiting for its turn when the process exits is gone, and
 * `--resume` does not bring it back. So each line is written to a file of its session before it
 * is submitted, and leaves it once its turn starts: `turn.start` carries its text, or
 * `$.prompt.submit` resolves. A process that starts on a session whose file still holds lines
 * from another process submits them again.
 *
 * Lines carry the token of the process that submitted them, which `$.state` keeps across a hot
 * reload: a reload leaves the queued prompt in place, so a reloaded mod submits nothing again.
 */

export interface SentHost {
  /** The session's id now; a `/clear` or a `/resume` changes it. */
  sessionId(): Promise<string>;
  /** Rejects when the file is missing. */
  read(path: string): Promise<string>;
  /** Creates the file's folder as needed. */
  write(path: string, text: string): Promise<void>;
  now(): Promise<number>;
  /**
   * `$.prompt.submit`: resolves when the prompt's turn starts, or to `{ drop }` when a hook
   * refused it.
   */
  submit(text: string): Promise<unknown>;
  log(text: string): void;
}

interface Line {
  ack: string;
  line: string;
  /** The token of the process that submitted it last; empty when that submit failed. */
  process: string;
  at: number;
  tries: number;
}

/** Submits after which a line that never started is dropped, with a log line. */
const MAX_TRIES = 3;
/** A line older than this is dropped: the server drops an unanswered decision after 30 days. */
const MAX_AGE_MS = 30 * 24 * 3600_000;

export class Sent {
  /** Each session's lines as its file holds them, once read. */
  private readonly sessions = new Map<string, Line[]>();
  /** Sessions whose lines from other processes went out again. */
  private readonly recovered = new Set<string>();
  /** File writes, one after another. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: SentHost,
    private readonly dir: string,
    /**
     * This process's token; undefined where `$.state` is missing, and then no line is submitted
     * again, since a reload could not be told from a new process.
     */
    private readonly process: string | undefined,
  ) {}

  /**
   * Records `line`, then submits it. False when it could not be recorded: nothing went out, and
   * the loop leaves the line unconfirmed for a later try.
   */
  async send(line: string, ack: string): Promise<boolean> {
    const me = await this.host.sessionId();
    const at = await this.host.now();
    const lines = await this.load(me);
    // A process that died between recording a line and confirming it leaves both: the loop
    // hands the line over again, and the file holds it. It goes out once, as `recover` would.
    const known = lines.find((l) => l.ack === ack);
    if (known && (this.process === undefined || known.process === this.process)) return true;
    if (known && known.tries >= MAX_TRIES) {
      this.host.log(`starbridge: gave up on the answer ${ack} after ${known.tries} submits`);
      await this.save(
        me,
        lines.filter((l) => l !== known),
      ).catch(() => undefined);
      return true;
    }
    const entry = known
      ? { ...known, process: this.process ?? "", tries: known.tries + 1 }
      : { ack, line, process: this.process ?? "", at, tries: 1 };
    try {
      await this.save(me, [...lines.filter((l) => l !== known), entry]);
    } catch (e) {
      this.host.log(`starbridge: could not record the answer ${ack}: ${(e as Error).message}`);
      return false;
    }
    this.enter(me, entry);
    return true;
  }

  /**
   * A turn started with `text`: each line it carries reached the model. Checks every session read
   * so far, since a `/clear` may come between the submit and the turn.
   */
  async started(text: string): Promise<void> {
    const me = await this.host.sessionId();
    await this.load(me);
    for (const [session, lines] of this.sessions) {
      const left = lines.filter((l) => !text.includes(l.line));
      if (left.length < lines.length) await this.save(session, left).catch(() => undefined);
    }
  }

  /**
   * Submits again the current session's lines that another process submitted, or whose submit
   * failed, once per session id. Then these come from this process, and only a turn start or a
   * failed submit changes them.
   */
  async recover(): Promise<void> {
    if (this.process === undefined) return;
    const me = await this.host.sessionId();
    if (!me) return;
    const lines = await this.load(me);
    const first = !this.recovered.has(me);
    this.recovered.add(me);
    const due = lines.filter((l) => l.process === "" || (first && l.process !== this.process));
    if (due.length === 0) return;
    const keep: Line[] = [];
    const again: Line[] = [];
    for (const l of lines) {
      if (!due.includes(l)) keep.push(l);
      else if (l.tries >= MAX_TRIES)
        this.host.log(`starbridge: gave up on the answer ${l.ack} after ${l.tries} submits`);
      else again.push({ ...l, process: this.process, tries: l.tries + 1 });
    }
    await this.save(me, [...keep, ...again]);
    for (const l of again) {
      this.host.log(`starbridge: submitting the answer ${l.ack} again: its prompt never ran`);
      this.enter(me, l);
    }
  }

  private enter(session: string, entry: Line) {
    this.host.submit(entry.line).then(
      (r) => {
        const drop = (r as { drop?: unknown } | undefined)?.drop;
        if (typeof drop === "string") void this.failed(session, entry.ack, `refused: ${drop}`);
        else void this.done(session, entry.ack);
      },
      (e) => void this.failed(session, entry.ack, (e as Error)?.message ?? String(e)),
    );
  }

  /** `$.prompt.submit` resolved: the line's turn started. */
  private async done(session: string, ack: string) {
    const lines = await this.load(session);
    if (lines.some((l) => l.ack === ack))
      await this.save(
        session,
        lines.filter((l) => l.ack !== ack),
      ).catch(() => undefined);
  }

  /** The submit failed: the next `recover` submits the line again. */
  private async failed(session: string, ack: string, why: string) {
    this.host.log(`starbridge: the answer ${ack} did not go in: ${why}`);
    const lines = await this.load(session);
    if (!lines.some((l) => l.ack === ack)) return;
    await this.save(
      session,
      lines.map((l) => (l.ack === ack ? { ...l, process: "" } : l)),
    ).catch(() => undefined);
  }

  private path(session: string) {
    return `${this.dir}/mod-sent/${encodeURIComponent(session)}.json`;
  }

  private async load(session: string): Promise<Line[]> {
    const cached = this.sessions.get(session);
    if (cached) return cached;
    let lines: Line[] = [];
    try {
      const parsed = JSON.parse(await this.host.read(this.path(session)));
      if (Array.isArray(parsed)) lines = parsed.filter(isLine);
    } catch {}
    const now = await this.host.now();
    lines = lines.filter((l) => now - l.at < MAX_AGE_MS);
    // A read that raced another one for the same session keeps the first.
    const raced = this.sessions.get(session);
    if (raced) return raced;
    this.sessions.set(session, lines);
    return lines;
  }

  /** Sets `session`'s lines and writes them; rejects when the write fails. */
  private save(session: string, lines: Line[]): Promise<void> {
    this.sessions.set(session, lines);
    const write = this.writes.then(() =>
      this.host.write(this.path(session), JSON.stringify(this.sessions.get(session) ?? [])),
    );
    this.writes = write.catch(() => undefined);
    return write;
  }
}

function isLine(l: unknown): l is Line {
  const x = l as Partial<Line> | null;
  return (
    typeof x?.ack === "string" &&
    typeof x.line === "string" &&
    typeof x.process === "string" &&
    typeof x.at === "number" &&
    typeof x.tries === "number"
  );
}
