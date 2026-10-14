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
 *
 * Every operation reads the file afresh, since another process on the session writes it too.
 */

export interface SentHost {
  /** The session's id now; a `/clear` or a `/resume` changes it. */
  sessionId(): Promise<string>;
  /** Undefined when the file is missing; rejects when it cannot be read. */
  read(path: string): Promise<string | undefined>;
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
  /**
   * Sent to this subagent, which has not read it yet (#1702); `line` is then what the parent gets
   * if the process exits first.
   */
  agent?: string;
}

/** Refused submits after which a line is dropped, with a log line. */
const MAX_REFUSED = 3;
/** A line older than this is dropped: the server drops an unanswered decision after 30 days. */
const MAX_AGE_MS = 30 * 24 * 3600_000;

export class Sent {
  /** Sessions whose file this process read. */
  private readonly sessions = new Set<string>();
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
   * Records `batch`, then submits it as one prompt (#1597). Returns the acks of the lines that went
   * out, now or before: not those it could not record, or that a `/clear` or `/resume` held back
   * meanwhile, which the loop leaves unconfirmed for a later try.
   */
  send(batch: { text: string; ack: string }[]): Promise<string[]> {
    return this.alone(async () => {
      const me = await this.host.sessionId();
      const at = await this.host.now();
      let lines = await this.loaded(me);
      if (!lines) return [];
      const entries: Line[] = [];
      /** Lines already out, from this process or another. */
      const out: string[] = [];
      for (const { text, ack } of batch) {
        // A process that died between recording a line and confirming it leaves both: the loop
        // hands the line over again, and the file holds it. It goes out once, as `recover` would.
        let known: Line | undefined = lines.find((l) => l.ack === ack);
        if (known && (this.process === undefined || known.process === this.process)) {
          out.push(ack);
          continue;
        }
        if (known && known.process !== "") {
          if (await this.host.elsewhere(me).catch(() => false)) {
            out.push(ack);
            continue;
          }
          // The process may have run the line's turn before it exited: then the file lacks it. A
          // process that started meanwhile may hold it now.
          const before = known.process;
          const fresh = await this.loaded(me);
          if (!fresh) return out;
          lines = [...fresh.filter((l) => !entries.some((e) => e.ack === l.ack)), ...entries];
          known = lines.find((l) => l.ack === ack);
          if (!known || (known.process !== "" && known.process !== before)) {
            out.push(ack);
            continue;
          }
        }
        const entry: Line = known
          ? { ...known, process: this.process ?? "" }
          : { ack, line: text, process: this.process ?? "", at, refused: 0 };
        lines = [...lines.filter((l) => l !== known), entry];
        entries.push(entry);
      }
      if (entries.length === 0) return out;
      try {
        await this.save(me, lines);
      } catch (e) {
        const acks = entries.map((l) => l.ack).join(", ");
        this.host.log(`starbridge: could not record the answers ${acks}: ${(e as Error).message}`);
        return out;
      }
      if ((await this.host.sessionId()) !== me) {
        // Left for session `me`: the loop holds the lines back until it is current again.
        const left = lines.map((l) => (entries.includes(l) ? { ...l, process: "" } : l));
        await this.save(me, left).catch(() => undefined);
        return out;
      }
      this.enter(me, entries);
      return [...out, ...entries.map((l) => l.ack)];
    });
  }

  /**
   * Records `batch` for subagent `agent`, as the prompt the parent gets should the process exit
   * before the subagent reads it (#1702), then runs `deliver`, the send. A send that fails leaves
   * no record. Claude Code keeps a message for a running subagent in memory until its next tool
   * round, so `read` drops the record only once the subagent has moved on.
   */
  toAgent(
    agent: string,
    batch: { text: string; ack: string }[],
    deliver: () => Promise<{ isDelivered: boolean; reason?: string }>,
  ): Promise<{ isDelivered: boolean; reason?: string }> {
    // Without a token a reload could not be told from a new process: nothing to recover by.
    if (this.process === undefined) return deliver();
    const process = this.process;
    return this.alone(async () => {
      const me = await this.host.sessionId();
      const at = await this.host.now();
      const acks = batch.map((l) => l.ack);
      const lines = await this.loaded(me);
      const entries = batch.map((l) => ({
        ack: l.ack,
        line: l.text,
        process,
        at,
        refused: 0,
        agent,
      }));
      const rest = lines?.filter((l) => !acks.includes(l.ack));
      const saved =
        rest !== undefined &&
        (await this.save(me, [...rest, ...entries]).then(
          () => true,
          (e) => {
            this.host.log(
              `starbridge: could not record the answers ${acks.join(", ")}: ${(e as Error).message}`,
            );
            return false;
          },
        ));
      // Sent without a record, an answer the subagent never read would be lost with the process.
      if (!saved) return { isDelivered: false, reason: "could not record it" };
      let r: { isDelivered: boolean; reason?: string };
      try {
        r = await deliver();
      } catch (e) {
        await this.save(me, rest).catch(() => undefined);
        throw e;
      }
      if (!r.isDelivered) await this.save(me, rest).catch(() => undefined);
      return r;
    });
  }

  /**
   * Subagent `agent` read what was sent to it up to `before`, the end of a tool round of its own:
   * Claude Code hands a subagent its messages after each round. Those records go.
   */
  read(agent: string, before: number): Promise<void> {
    return this.alone(async () => {
      // After a hot reload the current session is the one its records are under.
      await this.load(await this.host.sessionId()).catch(() => undefined);
      for (const session of this.sessions) {
        const lines = await this.load(session).catch(() => undefined);
        if (!lines) continue;
        const keep = lines.filter((l) => l.agent !== agent || l.at > before);
        if (keep.length < lines.length) await this.save(session, keep).catch(() => undefined);
      }
    });
  }

  /**
   * Subagent `agent` finished, its last tool round ending at `before` (undefined when this module
   * saw none): what was sent to it after then, it never read (#1729). Those records become lines
   * for the parent, which the next `recover` submits; the rest go. Returns whether any are left
   * for the parent.
   */
  finished(agent: string, before: number | undefined): Promise<boolean> {
    return this.alone(async () => {
      await this.load(await this.host.sessionId()).catch(() => undefined);
      let left = false;
      for (const session of this.sessions) {
        const lines = await this.load(session).catch(() => undefined);
        if (!lines?.some((l) => l.agent === agent)) continue;
        const keep: Line[] = [];
        for (const l of lines) {
          if (l.agent !== agent) keep.push(l);
          else if (before === undefined || l.at > before) {
            const { agent: _, ...line } = l;
            keep.push({ ...line, process: "" });
            left = true;
          }
        }
        await this.save(session, keep).catch(() => undefined);
      }
      return left;
    });
  }

  /**
   * A turn started with `text`: each line it carries reached the model. Checks every session read
   * so far, since a `/clear` may come between the submit and the turn.
   */
  started(text: string): Promise<void> {
    return this.alone(async () => {
      await this.load(await this.host.sessionId());
      for (const session of this.sessions) {
        const lines = await this.load(session);
        const left = lines.filter((l) => !text.includes(l.line));
        if (left.length < lines.length) await this.save(session, left).catch(() => undefined);
      }
    });
  }

  /**
   * Submits again the current session's lines that another process submitted, or whose submit
   * failed, once per session id, and not while another live process runs the session. Then these come from this process, and only a turn start or a
   * failed submit changes them.
   */
  recover(): Promise<void> {
    return this.alone(async () => {
      if (this.process === undefined) return;
      const me = await this.host.sessionId();
      if (!me) return;
      let lines = await this.load(me);
      // Other processes' lines go out once another live process no longer runs this session:
      // checked again at each turn's end until then.
      const theirs = (l: Line) => l.process !== "" && l.process !== this.process;
      const key = (l: Line) => `${l.ack}\n${l.process}`;
      const found = new Set(lines.filter(theirs).map(key));
      let take = false;
      if (!this.recovered.has(me)) {
        take = !(found.size > 0 && (await this.host.elsewhere(me).catch(() => false)));
        // A process that exited may have run some of its lines' turns since the first read, and
        // one that started meanwhile may have recorded its own, which stay with it.
        if (take && found.size > 0) lines = await this.load(me);
      }
      const due = lines.filter((l) => l.process === "" || (take && found.has(key(l))));
      if (due.length === 0) {
        if (take) this.recovered.add(me);
        return;
      }
      const keep = lines.filter((l) => !due.includes(l));
      const again: Line[] = [];
      for (const l of due)
        if (l.refused >= MAX_REFUSED)
          this.host.log(`starbridge: gave up on the answer ${l.ack}: refused ${l.refused} times`);
        else again.push({ ...l, process: this.process });
      // Marked once saved: a failed write leaves the lines to the next try.
      await this.save(me, [...keep, ...again]);
      if (take) this.recovered.add(me);
      if ((await this.host.sessionId()) !== me) {
        // Left for session `me`, as `send` leaves a line.
        this.recovered.delete(me);
        const free = again.map((l) => ({ ...l, process: "" }));
        await this.save(me, [...keep, ...free]).catch(() => undefined);
        return;
      }
      for (const l of again)
        this.host.log(`starbridge: submitting the answer ${l.ack} again: its prompt never ran`);
      if (again.length > 0) this.enter(me, again);
    });
  }

  /** Submits `entries` as one prompt, one line each. */
  private enter(session: string, entries: Line[]) {
    const acks = entries.map((l) => l.ack);
    this.host.submit(entries.map((l) => l.line).join("\n")).then(
      (r) => {
        const drop = (r as { drop?: unknown } | undefined)?.drop;
        if (typeof drop === "string") void this.failed(session, acks, `refused: ${drop}`);
        else void this.done(session, acks);
      },
      (e) => void this.failed(session, acks, (e as Error)?.message ?? String(e)),
    );
  }

  /** `$.prompt.submit` resolved: the lines' turn started. */
  private done(session: string, acks: string[]) {
    return this.alone(async () => {
      const lines = await this.load(session);
      if (lines.some((l) => acks.includes(l.ack)))
        await this.save(
          session,
          lines.filter((l) => !acks.includes(l.ack)),
        ).catch(() => undefined);
    });
  }

  /** The submit failed: the next `recover` submits the lines again. */
  private failed(session: string, acks: string[], why: string) {
    this.host.log(`starbridge: the answers ${acks.join(", ")} did not go in: ${why}`);
    return this.alone(async () => {
      const lines = await this.load(session);
      if (!lines.some((l) => acks.includes(l.ack))) return;
      await this.save(
        session,
        lines.map((l) =>
          acks.includes(l.ack) ? { ...l, process: "", refused: l.refused + 1 } : l,
        ),
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

  /**
   * Rejects when the file cannot be read, so that no write replaces lines it could not see. One
   * that does not parse is replaced: holding every answer back on it would be worse.
   */
  private async load(session: string): Promise<Line[]> {
    this.sessions.add(session);
    const text = await this.host.read(this.path(session));
    let lines: Line[] = [];
    try {
      const parsed = JSON.parse(text ?? "[]");
      if (Array.isArray(parsed)) lines = parsed.filter(isLine);
    } catch {}
    const now = await this.host.now();
    return lines.filter((l) => now - l.at < MAX_AGE_MS);
  }

  /** `load`, or undefined with a log line when the file cannot be read. */
  private async loaded(session: string): Promise<Line[] | undefined> {
    try {
      return await this.load(session);
    } catch (e) {
      this.host.log(`starbridge: could not read the answers sent: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Writes `session`'s lines; rejects when the write fails. */
  private async save(session: string, lines: Line[]): Promise<void> {
    await this.host.write(this.path(session), JSON.stringify(lines));
  }
}

function isLine(l: unknown): l is Line {
  const x = l as Partial<Line> | null;
  return (
    typeof x?.ack === "string" &&
    typeof x.line === "string" &&
    typeof x.process === "string" &&
    typeof x.at === "number" &&
    typeof x.refused === "number" &&
    (x.agent === undefined || typeof x.agent === "string")
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
      const s = firstObject(await fs.read(`${dir}/${f.name}`));
      if (
        s?.sessionId === session &&
        typeof s.pid === "number" &&
        s.pid !== own &&
        (await runs(s.pid))
      )
        return true;
    } catch {}
  }
  return false;
}

/**
 * The object a session record starts with. Claude Code rewrites the file without truncating it,
 * so a shorter record leaves the end of the previous one after it, as cli/src/claude.ts reads it.
 */
function firstObject(text: string): { pid?: unknown; sessionId?: unknown } | undefined {
  for (let end = text.indexOf("}"); end !== -1; end = text.indexOf("}", end + 1)) {
    try {
      const value = JSON.parse(text.slice(0, end + 1));
      return value && typeof value === "object" ? value : undefined;
    } catch {}
  }
  return undefined;
}
