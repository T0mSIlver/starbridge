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
  /**
   * Must not wait for the turn to start: a prompt submitted mid-turn waits for its own. A host
   * that can tell the submit failed returns or resolves false, and the line stays unconfirmed for
   * a later try.
   */
  submit(text: string): unknown;
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
  /** A poll that comes back sooner than this with nothing waits out the rest. */
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

/** `$STARBRIDGE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/starbridge`, else `~/.config/starbridge`, as the CLI. */
export function configDir(env: {
  STARBRIDGE_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  HOME?: string;
}): string {
  if (env.STARBRIDGE_CONFIG_DIR) return env.STARBRIDGE_CONFIG_DIR;
  return `${env.XDG_CONFIG_HOME || `${env.HOME}/.config`}/starbridge`;
}

/** The CLI's first error line, without the "starbridge: " the status line adds again. */
function firstLine(stderr: string): string {
  return (stderr.trim().split("\n")[0] ?? "").replace(/^starbridge:\s*/, "");
}

export class Poller {
  private stopped = false;
  private failures = 0;
  /** The state file's time when this session last read it; a /clear makes it unread again. */
  private seen: { session: string; mtime: number; at: number } | undefined;
  /** The session id this poller last held the lease under; a `/clear` changes the id. */
  private leasedAs: string | undefined;
  private readonly leasePath: string;
  private readonly statePath: string;
  /** Resolves when the loop has ended. */
  readonly done: Promise<void>;

  constructor(
    private readonly host: Host,
    dir: string,
    private readonly command = "starbridge",
    private readonly t: Timing = TIMING,
    /**
     * Lines submitted but not yet confirmed, so a retried confirm submits nothing twice; shared
     * with `AgentLoop` (agent.ts) across a switch.
     */
    private readonly unconfirmed = new Set<string>(),
  ) {
    this.leasePath = `${dir}/mod-poller.json`;
    this.statePath = `${dir}/state.json`;
    this.done = this.loop();
  }

  /** Ends the loop after the current step and gives up the lease at once, so another session polls. */
  async stop(): Promise<void> {
    this.stopped = true;
    const me = await this.host.sessionId();
    const lease = await this.readLease();
    if (lease && (lease.session === me || lease.session === this.leasedAs))
      await this.host.write(this.leasePath, JSON.stringify({ ...lease, until: 0 }));
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
      const handed = await this.answers(me, ["--wait", String(this.t.waitSeconds)]);
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
    if ((await this.answers(me, [])) !== undefined) this.seen = { session: me, mtime, at: now };
  }

  /**
   * Runs one `starbridge answers`, submits each answer it hands over and confirms them. Returns
   * how many, or undefined after an error, which it has already waited out.
   */
  private async answers(me: string, extra: string[]): Promise<number | undefined> {
    const timeoutMs = (this.t.waitSeconds + 30) * 1000;
    const base = [this.command, "answers", "--session", me];
    const r = await this.host.run([...base, ...extra], timeoutMs);
    if (r.exitCode !== 0) {
      await this.fail(firstLine(r.stderr) || `exit ${r.exitCode}`);
      return undefined;
    }
    // Warnings on success, such as an answer that failed its checks.
    for (const line of r.stderr.split("\n")) if (line.trim()) this.host.log(line);
    if (this.failures > 0) this.host.status(undefined);
    this.failures = 0;
    let handed = 0;
    const done: string[] = [];
    for (const text of r.stdout.split("\n")) {
      if (!text.trim()) continue;
      let parsed: { decisionId?: unknown; ack?: unknown; line?: unknown };
      try {
        parsed = JSON.parse(text);
      } catch {
        this.host.log(`starbridge: unreadable line from the CLI: ${text.slice(0, 200)}`);
        continue;
      }
      const { decisionId: id, line } = parsed;
      if (typeof id !== "string" || typeof line !== "string") continue;
      const ack = typeof parsed.ack === "string" ? parsed.ack : id;
      // A /clear during the call made another session current: the answer waits, unconfirmed,
      // until session `me` is resumed.
      if ((await this.host.sessionId()) !== me) {
        this.host.log(`starbridge: held back the answer to ${id}: its session ${me} ended`);
        continue;
      }
      if (!this.unconfirmed.has(ack)) {
        if ((await this.host.submit(line)) === false) continue;
        this.unconfirmed.add(ack);
        handed++;
      }
      done.push(ack);
    }
    if (done.length > 0) {
      const ack = await this.host.run([...base, ...done.flatMap((id) => ["--ack", id])], timeoutMs);
      if (ack.exitCode !== 0) {
        await this.fail(firstLine(ack.stderr) || `exit ${ack.exitCode}`);
        return undefined;
      }
      for (const id of done) this.unconfirmed.delete(id);
    }
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
