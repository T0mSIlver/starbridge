/**
 * Decisions in the agent: posts them for local clients, keeps the machine's one answer long-poll
 * open, posts their waiting state, and hands each session the answers to the decisions it asked.
 * Everything lives in the CLI's state file, under its lock, so an agent restart loses nothing a
 * session has not confirmed, and the CLI's own path (no agent) reads the same state.
 */
import { activeMembers, type Directory, ProtocolError } from "@starbridge/protocol";
import { codexNotice, codexQueue, codexReachable } from "../codex";
import { type Ctx, iso, session, UsageError } from "../context";
import {
  type AskInput,
  ackLines,
  delivery,
  poll,
  postDecision,
  postWaiting,
  sessionLines,
  takeAnswer,
} from "../decisions";
import type { SessionEvent, Status } from "./api";
import { type Feature, HttpError, type Hub, holdSeconds, pause } from "./server";

/** The server holds each answer poll this long, at most. */
const POLL_SECONDS = 60;
/** Re-read the directory this often even when no answer came, to notice a revocation. */
const DIRECTORY_MS = 10 * 60_000;
const BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** How long the agent waits before queueing an answer into a Codex session again. */
const CODEX_RETRY_MS = 60_000;
/** How many times the agent tries to queue one answer into a Codex session. */
const CODEX_TRIES = 30;
/** How often an unpaired agent checks whether `starbridge pair` ran. */
const UNPAIRED_MS = 5_000;

/** Why the machine should post a quota snapshot now. */
export type QuotaWanted = "a device joined" | "a device asked";

export class Decisions implements Feature {
  private lastOkAt: Date | undefined;
  private lastError: string | undefined;
  /** Codex answers whose `codex queue` failed, by decision id: tries so far, and when next. */
  private retries = new Map<string, { tries: number; at: number }>();
  /** The active devices and the last quota ask, as of the previous poll. */
  private devices: Set<string> | undefined;
  private quotaAsked: string | undefined;

  constructor(
    private readonly hub: Hub,
    private readonly wantQuota: (why: QuotaWanted) => void = () => {},
  ) {}

  private get ctx(): Ctx {
    return this.hub.ctx;
  }

  routes = [
    {
      method: "POST",
      path: "/v1/decisions",
      handle: async (req: { body: unknown }) => {
        const input = (req.body as { input?: unknown } | undefined)?.input;
        if (typeof input !== "object" || input === null)
          throw new HttpError(400, "bad-request", "post {input: {question, default, ...}}");
        const ask = input as AskInput;
        // The asking process knows its directory; the agent's would name the wrong project.
        if (typeof ask.project !== "string")
          throw new HttpError(400, "bad-request", "input.project is required");
        const decision = await postDecision(this.ctx, session(this.ctx), ask);
        const reachable = ask.codex ? await codexReachable(ask.codex) : false;
        return { id: decision.id, delivery: delivery(ask, reachable) };
      },
    },
    {
      method: "POST",
      path: "/v1/decisions/:id/waiting",
      handle: async (req: { body: unknown; params: Record<string, string> }) => {
        const state = (req.body as { state?: unknown } | undefined)?.state;
        if (state !== "working" && state !== "waiting")
          throw new HttpError(400, "bad-request", 'post {state: "working" | "waiting"}');
        const id = req.params.id ?? "";
        if (!this.ctx.store.state().asked[id])
          throw new HttpError(
            404,
            "unknown-decision",
            `${id} is not a decision this machine asked`,
          );
        return { posted: await postWaiting(this.ctx, session(this.ctx), id, state) };
      },
    },
    {
      method: "POST",
      path: "/v1/answers/next",
      handle: async (req: { body: unknown; signal: AbortSignal }) => {
        const b = (req.body ?? {}) as { id?: unknown; wait?: unknown };
        const id = typeof b.id === "string" ? b.id : undefined;
        const asked = id ? this.ctx.store.state().asked[id] : undefined;
        if (id && !asked)
          throw new HttpError(
            404,
            "unknown-decision",
            `${id} is not a decision this machine asked`,
          );
        const wait = holdSeconds(b.wait === undefined ? undefined : String(b.wait));
        const end = Date.now() + wait * 1000;
        let found = takeAnswer(this.ctx.store, id);
        while (!found && !req.signal.aborted && Date.now() < end) {
          await this.hub.changed(end - Date.now(), req.signal);
          found = takeAnswer(this.ctx.store, id);
        }
        return found ?? {};
      },
    },
  ];

  events(id: string): SessionEvent[] {
    return sessionLines(this.ctx.store.state(), id);
  }

  ack(id: string, tokens: string[]) {
    this.ctx.store.updateState((st) => ackLines(st, id, tokens));
  }

  status(into: Status) {
    into.server = {
      reachable: this.lastError === undefined && this.lastOkAt !== undefined,
      ...(this.lastOkAt ? { lastOkAt: iso(this.lastOkAt) } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * Snapshots are sealed to the devices in the directory, so a device that joined reads nothing
   * until the next one: ask for one now, and when a device asks. The first poll only records.
   */
  private watch(dir: Directory, quotaAsked: string | undefined) {
    const now = new Set(activeMembers(dir, "device").map((d) => d.id));
    const before = this.devices;
    this.devices = now;
    if (before && [...now].some((id) => !before.has(id))) this.wantQuota("a device joined");
    const asked = this.quotaAsked;
    this.quotaAsked = quotaAsked;
    if (before && quotaAsked !== undefined && quotaAsked !== asked)
      this.wantQuota("a device asked");
  }

  /**
   * Queues each new answer to a Codex session into it with `codex queue`, and marks it seen only
   * once that succeeded: an agent that dies meanwhile queues it again, rather than never. A
   * session that is gone gets CODEX_TRIES tries, a minute apart; the answer stays for a `wait`.
   */
  private async deliverCodex() {
    const now = Date.now();
    for (const [id, a] of Object.entries(this.ctx.store.state().answers)) {
      const asked = this.ctx.store.state().asked[id];
      if (a.seen || !asked?.codex || !asked.session) continue;
      const retry = this.retries.get(id) ?? { tries: 0, at: 0 };
      if (retry.tries >= CODEX_TRIES || retry.at > now) continue;
      const error = await codexQueue(asked.codex, asked.session, codexNotice(id));
      if (error === undefined) {
        this.retries.delete(id);
        this.ctx.store.updateState((st) => {
          const x = st.answers[id];
          if (x) x.seen = true;
        });
        this.hub.log(`answer to ${id} queued into Codex session ${asked.session}`);
        continue;
      }
      const tries = retry.tries + 1;
      this.retries.set(id, { tries, at: now + CODEX_RETRY_MS });
      this.hub.log(
        tries < CODEX_TRIES
          ? `answer to ${id}: codex queue failed (${error}); retrying in 1 min`
          : `answer to ${id}: codex queue failed ${tries} times (${error}); giving up`,
      );
    }
  }

  /** One long-poll after another from the shared cursor, each held until an answer comes. */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    // The first poll returns at once, so `status` knows soon whether the server is reachable.
    let first = true;
    let directory: { dir: Directory; at: number } | undefined;
    while (!signal.aborted) {
      if (!this.ctx.store.machine()) {
        this.lastError = "not paired: run `starbridge pair`";
        await pause(UNPAIRED_MS, signal);
        continue;
      }
      const st = this.ctx.store.state();
      const seconds = first ? 0 : POLL_SECONDS;
      try {
        if (directory && Date.now() - directory.at > DIRECTORY_MS) directory = undefined;
        const s = session(this.ctx);
        const r = await poll({ ...this.ctx, signal }, s, {
          cursor: st.cursor,
          seconds,
          shared: true,
          ...(directory ? { directory: directory.dir } : {}),
          watch: this.quotaAsked !== undefined ? { quotaAsked: this.quotaAsked } : {},
        });
        if (r.directory !== directory?.dir) directory = { dir: r.directory, at: Date.now() };
        this.watch(r.directory, r.quotaAsked);
        this.lastOkAt = this.ctx.now();
        if (this.lastError !== undefined) this.hub.log("server reachable again");
        this.lastError = undefined;
        failures = 0;
        first = false;
        this.hub.notify();
        await this.deliverCodex();
      } catch (e) {
        if (signal.aborted) break;
        const message = (e as Error).message;
        directory = undefined;
        failures++;
        const fatal = e instanceof UsageError || e instanceof ProtocolError;
        const delay = fatal
          ? MAX_BACKOFF_MS
          : Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (failures - 1));
        if (message !== this.lastError)
          this.hub.log(`answers: ${message}; retrying in ${Math.round(delay / 1000)} s`);
        this.lastError = message;
        await pause(delay, signal);
      }
    }
  }
}
