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
 * Nor does a process that shares its session with another live one.
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
  /**
   * Whether another live process runs `session`, such as a `claude --resume` in a second
   * terminal: the lines it submitted may still be queued there.
   */
  elsewhere(session: string): Promise<boolean>;
  log(text: string): void;
}

interface Line {
  ack: string;
  line: string;
  /** The token of the process that submitted it last; empty when that submit failed. */
  process: string;
  at: number;
  /** Submits a hook refused or the engine rejected; a process exiting is not one. */
  refused: number;
}

/** Refused submits after which a line is dropped, with a log line. */
const MAX_REFUSED = 3;
/** A line older than this is dropped: the server drops an unanswered decision after 30 days. */
const MAX_AGE_MS = 30 * 24 * 3600_000;

export class Sent {
  /** Each session's lines as its file holds them, once read. */
  private readonly sessions = new Map<string, Line[]>();
  /** Sessions whose lines from other processes went out again. */
  private readonly recovered = new Set<string>();
  /** Every operation runs alone, from its read to its submit. */
  private queue: Promise<unknown> = Promise.resolve();

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
   * Records `line`, then submits it. False when nothing went out: it could not be recorded, or a
   * `/clear` or `/resume` came meanwhile. The loop then leaves the line unconfirmed for a later
   * try.
   */
  send(line: string, ack: string): Promise<boolean> {
    return this.alone(async () => {
      const me = await this.host.sessionId();
      const at = await this.host.now();
      const lines = await this.load(me);
      // A process that died between recording a line and confirming it leaves both: the loop
      // hands the line over again, and the file holds it. It goes out once, as `recover` would.
      const known = lines.find((l) => l.ack === ack);
      if (known && (this.process === undefined || known.process === this.process)) return true;
      if (known && known.process !== "" && (await this.host.elsewhere(me).catch(() => false)))
        return true;
      const entry = known
        ? { ...known, process: this.process ?? "" }
        : { ack, line, process: this.process ?? "", at, refused: 0 };
      const rest = lines.filter((l) => l !== known);
      try {
        await this.save(me, [...rest, entry]);
      } catch (e) {
        this.host.log(`starbridge: could not record the answer ${ack}: ${(e as Error).message}`);
        return false;
      }
      if ((await this.host.sessionId()) !== me) {
        // Left for session `me`: the loop holds the line back until it is current again.
        await this.save(me, [...rest, { ...entry, process: "" }]).catch(() => undefined);
        return false;
      }
      this.enter(me, entry);
      return true;
    });
  }

  /**
   * A turn started with `text`: each line it carries reached the model. Checks every session read
   * so far, since a `/clear` may come between the submit and the turn.
   */
  started(text: string): Promise<void> {
    return this.alone(async () => {
      await this.load(await this.host.sessionId());
      for (const [session, lines] of this.sessions) {
        const left = lines.filter((l) => !text.includes(l.line));
        if (left.length < lines.length) await this.save(session, left).catch(() => undefined);
      }
    });
  }

  /**
   * Submits again the current session's lines that another process submitted, or whose submit
   * failed, once per session id. Then these come from this process, and only a turn start or a
   * failed submit changes them.
   */
  recover(): Promise<void> {
    return this.alone(async () => {
      if (this.process === undefined) return;
      const me = await this.host.sessionId();
      if (!me) return;
      const lines = await this.load(me);
      const first = !this.recovered.has(me);
      this.recovered.add(me);
      const shared = first && (await this.host.elsewhere(me).catch(() => false));
      const due = lines.filter(
        (l) => l.process === "" || (first && !shared && l.process !== this.process),
      );
      if (due.length === 0) return;
      const keep = lines.filter((l) => !due.includes(l));
      const again: Line[] = [];
      for (const l of due)
        if (l.refused >= MAX_REFUSED)
          this.host.log(`starbridge: gave up on the answer ${l.ack}: refused ${l.refused} times`);
        else again.push({ ...l, process: this.process });
      await this.save(me, [...keep, ...again]);
      if ((await this.host.sessionId()) !== me) {
        this.recovered.delete(me);
        return;
      }
      for (const l of again) {
        this.host.log(`starbridge: submitting the answer ${l.ack} again: its prompt never ran`);
        this.enter(me, l);
      }
    });
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
  private done(session: string, ack: string) {
    return this.alone(async () => {
      const lines = await this.load(session);
      if (lines.some((l) => l.ack === ack))
        await this.save(
          session,
          lines.filter((l) => l.ack !== ack),
        ).catch(() => undefined);
    });
  }

  /** The submit failed: the next `recover` submits the line again. */
  private failed(session: string, ack: string, why: string) {
    this.host.log(`starbridge: the answer ${ack} did not go in: ${why}`);
    return this.alone(async () => {
      const lines = await this.load(session);
      if (!lines.some((l) => l.ack === ack)) return;
      await this.save(
        session,
        lines.map((l) => (l.ack === ack ? { ...l, process: "", refused: l.refused + 1 } : l)),
      ).catch(() => undefined);
    });
  }

  private alone<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
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
    this.sessions.set(session, lines);
    return lines;
  }

  /** Writes `session`'s lines, and keeps them once written; rejects when the write fails. */
  private async save(session: string, lines: Line[]): Promise<void> {
    await this.host.write(this.path(session), JSON.stringify(lines));
    this.sessions.set(session, lines);
  }
}

function isLine(l: unknown): l is Line {
  const x = l as Partial<Line> | null;
  return (
    typeof x?.ack === "string" &&
    typeof x.line === "string" &&
    typeof x.process === "string" &&
    typeof x.at === "number" &&
    typeof x.refused === "number"
  );
}

/**
 * Whether a live Claude Code process other than `own` runs session `session`, from the
 * `<pid>.json` files Claude Code keeps in `<its config folder>/sessions`; files of processes that
 * ended stay behind, so `runs` checks each pid.
 */
export async function sessionElsewhere(
  session: string,
  own: number,
  fs: { list(dir: string): Promise<{ name: string }[]>; read(path: string): Promise<string> },
  dir: string,
  runs: (pid: number) => Promise<boolean>,
): Promise<boolean> {
  for (const f of await fs.list(dir).catch(() => [])) {
    if (!/^\d+\.json$/.test(f.name) || f.name === `${own}.json`) continue;
    try {
      const s = JSON.parse(await fs.read(`${dir}/${f.name}`)) as {
        pid?: unknown;
        sessionId?: unknown;
      };
      if (
        s.sessionId === session &&
        typeof s.pid === "number" &&
        s.pid !== own &&
        (await runs(s.pid))
      )
        return true;
    } catch {}
  }
  return false;
}
