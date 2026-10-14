import type { Line } from "./agent.ts";

/**
 * The answer loop, apart from the engine's `$` so plain tests can drive it.
 *
 * Every session that loads the mod runs this loop, but only one per machine polls the server: the
 * holder of a lease file in the CLI's config directory. The holder runs `starbridge answers
 * --session <its id> --wait 25` back to back (the host aborts a call after 30 s); the others
 * watch the CLI's state file and run `starbridge answers --session <id>` without `--wait` when
 * it changes, which never touches the network. The CLI holds the keys, opens and verifies each
 * answer, and hands a session only the answers to decisions it asked, until the poller confirms
 * it submitted them with `starbridge answers --ack`.
 */

export interface Host {
  /** The session's id now; a `/clear` changes it. */
  sessionId(): Promise<string>;
  run(
    argv: string[],
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  /** Rejects when the file is missing. */
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  /** Undefined when the file is missing. */
  mtime(path: string): Promise<number | undefined>;
  now(): Promise<number>;
  sleep(ms: number): Promise<void>;
  /** `AgentHost.submit`: one message for the lines one read brought, returning the acks it took. */
  submit(lines: Line[]): string[] | Promise<string[]>;
  /** True while a submitted prompt waits for its turn: `AgentHost.starting`. */
  starting(): boolean;
  status(text: string | undefined): void;
  log(text: string): void;
}

export interface Timing {
  /** Seconds the server may hold one poll. */
  waitSeconds: number;
  /** How often a session that does not poll checks the state file. */
  checkMs: number;
  /** How often it reads its answers even when no change of the state file was seen. */
  recheckMs: number;
  /** How long a lease lasts past its last renewal. */
  leaseMs: number;
  /**
   * A poll that comes back sooner than this with nothing waits out the rest; while a prompt waits
   * for its turn, polls don't wait and this is the time between them.
   */
  minCycleMs: number;
  /** First retry delay after an error, doubled each time up to `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
}

export const TIMING: Timing = {
  waitSeconds: 25,
  checkMs: 2_000,
  recheckMs: 30_000,
  leaseMs: 60_000,
  minCycleMs: 2_000,
  backoffMs: 2_000,
  maxBackoffMs: 60_000,
};

interface Lease {
  session: string;
  until: number;
}

/**
 * `$STARBRIDGE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/starbridge`, else `~/.config/starbridge`, as
 * the CLI; on Windows (`OS=Windows_NT`) home is `USERPROFILE`, as the CLI reads it, whatever
 * `HOME` a Git Bash set.
 */
export function configDir(env: {
  STARBRIDGE_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  HOME?: string;
  USERPROFILE?: string;
  OS?: string;
}): string {
  if (env.STARBRIDGE_CONFIG_DIR) return env.STARBRIDGE_CONFIG_DIR;
  const home = env.OS === "Windows_NT" ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  return `${env.XDG_CONFIG_HOME || `${home}/.config`}/starbridge`;
}

/** The CLI's first error line, without the "starbridge: " the status line adds again. */
function firstLine(stderr: string): string {
  return (stderr.trim().split("\n")[0] ?? "").replace(/^starbridge:\s*/, "");
}

export class Poller {
  private stopped = false;
  private failures = 0;
  /** Lines the host held back in the last `answers`. */
  private held = 0;
  /** The state file's time when this session last read it; a /clear makes it unread again. */
  private seen: { session: string; mtime: number; at: number } | undefined;
  /** The session id this poller last held the lease under; a `/clear` changes the id. */
  private leasedAs: string | undefined;
  private readonly leasePath: string;
  private readonly cliPath: string;
  private readonly statePath: string;
  /** Resolves when the loop has ended. */
  readonly done: Promise<void>;

  constructor(
    private readonly host: Host,
    dir: string,
    /** The CLI; by default the path setup recorded in `dir`, else `starbridge` on the PATH (#612). */
    private readonly command?: string,
    private readonly t: Timing = TIMING,
    /**
     * Lines submitted but not yet confirmed, so a retried confirm submits nothing twice; shared
     * with `AgentLoop` (agent.ts) across a switch.
     */
    private readonly unconfirmed = new Set<string>(),
  ) {
    this.leasePath = `${dir}/mod-poller.json`;
    this.cliPath = `${dir}/cli-path`;
    this.statePath = `${dir}/state.json`;
    // Nothing awaits a loop that ended before `stop`: a rejection would take the harness down (#1365).
    this.done = this.loop().catch((e) => {
      try {
        this.host.log(`starbridge: the answer loop stopped: ${(e as Error).message}`);
      } catch {}
    });
  }

  /**
   * Ends the loop after the current step and gives up the lease at once, so another session polls.
   * Never rejects: it runs after the session ended, when the host may throw (#1365).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    try {
      const me = await this.host.sessionId();
      const lease = await this.readLease();
      if (lease && (lease.session === me || lease.session === this.leasedAs))
        await this.host.write(this.leasePath, JSON.stringify({ ...lease, until: 0 }));
    } catch {
      // The lease runs out on its own.
    }
  }

  private async cli(): Promise<string> {
    if (this.command) return this.command;
    try {
      const recorded = (await this.host.read(this.cliPath)).trim();
      // A binary removed since setup recorded it: the PATH may still hold another.
      if (recorded && (await this.host.mtime(recorded)) !== undefined) return recorded;
    } catch {}
    return "starbridge";
  }

  private async loop() {
    while (!this.stopped) {
      try {
        await this.step();
      } catch (e) {
        await this.fail((e as Error).message);
      }
    }
  }

  private async step() {
    const me = await this.host.sessionId();
    if (!me) {
      await this.host.sleep(this.t.checkMs);
      return;
    }
    if (await this.lease(me, this.t.leaseMs)) {
      const started = await this.host.now();
      const wait = this.host.starting() ? 0 : this.t.waitSeconds;
      const handed = await this.answers(me, ["--wait", String(wait)]);
      if (handed === undefined) return;
      const left = started + this.t.minCycleMs - (await this.host.now());
      if (handed === 0 && left > 0) await this.host.sleep(left);
      return;
    }
    const mtime = await this.host.mtime(this.statePath);
    const now = await this.host.now();
    const unchanged = this.seen?.session === me && this.seen.mtime === mtime;
    if (mtime === undefined || (unchanged && now - (this.seen?.at ?? 0) < this.t.recheckMs)) {
      await this.host.sleep(this.t.checkMs);
      return;
    }
    if ((await this.answers(me, [])) === undefined) return;
    // A line the host held back for the turn's end is read again at the next check (#1484).
    if (this.held === 0) this.seen = { session: me, mtime, at: now };
    else await this.host.sleep(this.t.checkMs);
  }

  /**
   * Confirms the lines among `acks` that the CLI still hands this session, and returns those: a
   * line a `wait` or `waiting` printed meanwhile is not handed over again (#1484).
   */
  async claim(acks: string[]): Promise<string[]> {
    const me = await this.host.sessionId();
    const base = [await this.cli(), "answers", "--session", me];
    const timeoutMs = (this.t.waitSeconds + 30) * 1000;
    const r = await this.host.run(base, timeoutMs);
    if (r.exitCode !== 0) return [];
    const pending = new Set<string>();
    for (const text of r.stdout.split("\n")) {
      try {
        const l = JSON.parse(text) as { decisionId?: unknown; ack?: unknown };
        const ack = typeof l.ack === "string" ? l.ack : l.decisionId;
        if (typeof ack === "string") pending.add(ack);
      } catch {}
    }
    const mine = acks.filter((a) => pending.has(a));
    if (mine.length === 0) return [];
    const ack = await this.host.run([...base, ...mine.flatMap((a) => ["--ack", a])], timeoutMs);
    if (ack.exitCode !== 0) return [];
    // What it confirmed now: not a line a `wait` or `waiting` took since the read. A CLI older
    // than that prints nothing.
    try {
      const acked = (JSON.parse(ack.stdout) as { acked?: unknown }).acked;
      if (Array.isArray(acked)) return acked.filter((a): a is string => typeof a === "string");
    } catch {}
    return mine;
  }

  /**
   * Runs one `starbridge answers`, submits each answer it hands over and confirms them. Returns
   * how many, or undefined after an error, which it has already waited out.
   */
  private async answers(me: string, extra: string[]): Promise<number | undefined> {
    const timeoutMs = (this.t.waitSeconds + 30) * 1000;
    const base = [await this.cli(), "answers", "--session", me];
    const r = await this.host.run([...base, ...extra], timeoutMs);
    if (r.exitCode !== 0) {
      await this.fail(firstLine(r.stderr) || `exit ${r.exitCode}`);
      return undefined;
    }
    // Warnings on success, such as an answer that failed its checks.
    for (const line of r.stderr.split("\n")) if (line.trim()) this.host.log(line);
    if (this.failures > 0) this.host.status(undefined);
    this.failures = 0;
    const lines: Line[] = [];
    for (const text of r.stdout.split("\n")) {
      if (!text.trim()) continue;
      let parsed: { decisionId?: unknown; ack?: unknown; line?: unknown; subagent?: unknown };
      try {
        parsed = JSON.parse(text);
      } catch {
        this.host.log(`starbridge: unreadable line from the CLI: ${text.slice(0, 200)}`);
        continue;
      }
      const { decisionId: id, line } = parsed;
      if (typeof id !== "string" || typeof line !== "string") continue;
      lines.push({
        text: line,
        ack: typeof parsed.ack === "string" ? parsed.ack : id,
        ...(typeof parsed.subagent === "string" ? { subagent: parsed.subagent } : {}),
      });
    }
    // A /clear during the call made another session current: the answers wait, unconfirmed,
    // until session `me` is resumed.
    if (lines.length > 0 && (await this.host.sessionId()) !== me) {
      this.host.log(
        `starbridge: held back the answers ${lines.map((l) => l.ack).join(", ")}: their session ${me} ended`,
      );
      this.held = 0;
      return 0;
    }
    const due = lines.filter((l) => !this.unconfirmed.has(l.ack));
    const taken = due.length > 0 ? await this.host.submit(due) : [];
    for (const a of taken) this.unconfirmed.add(a);
    const handed = taken.length;
    const held = due.length - handed;
    const done = lines.filter((l) => this.unconfirmed.has(l.ack)).map((l) => l.ack);
    if (done.length > 0) {
      const ack = await this.host.run([...base, ...done.flatMap((id) => ["--ack", id])], timeoutMs);
      if (ack.exitCode !== 0) {
        await this.fail(firstLine(ack.stderr) || `exit ${ack.exitCode}`);
        return undefined;
      }
      for (const id of done) this.unconfirmed.delete(id);
    }
    this.held = held;
    return handed;
  }

  /** Waits before the next try, twice as long after each error in a row. */
  private async fail(message: string) {
    this.failures++;
    const delay = Math.min(this.t.maxBackoffMs, this.t.backoffMs * 2 ** (this.failures - 1));
    const text = `starbridge: ${message}`;
    this.host.status(text);
    this.host.log(`${text}; retrying in ${Math.round(delay / 1000)} s`);
    // A poller that backs off keeps its lease, so the other sessions do not all start failing.
    try {
      const me = await this.host.sessionId();
      const held = (await this.readLease())?.session;
      if (me && held !== undefined && (held === me || held === this.leasedAs))
        await this.lease(me, delay + this.t.leaseMs);
    } catch {
      // The lease is an optimisation; losing it costs one more poller.
    }
    await this.host.sleep(delay);
  }

  private async readLease(): Promise<Lease | undefined> {
    try {
      const lease = JSON.parse(await this.host.read(this.leasePath)) as Lease;
      return typeof lease.session === "string" && typeof lease.until === "number"
        ? lease
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Takes or renews the lease unless another live session holds it. Two sessions that write at
   * once both read back the last write, so at most one goes on to poll; a double poll would
   * still be harmless, since the CLI keeps each answer once and hands it over once.
   */
  private async lease(me: string, forMs: number): Promise<boolean> {
    // A step still running when `stop` gave the lease up must not take it back.
    if (this.stopped) return false;
    const now = await this.host.now();
    const held = await this.readLease();
    const ours = held?.session === me || (held !== undefined && held.session === this.leasedAs);
    if (held && !ours && held.until > now) return false;
    const mine = ours && (held?.until ?? 0) > now;
    await this.host.write(this.leasePath, JSON.stringify({ session: me, until: now + forMs }));
    if (!mine) {
      await this.host.sleep(100);
      if ((await this.readLease())?.session !== me) return false;
    }
    this.leasedAs = me;
    return true;
  }
}
