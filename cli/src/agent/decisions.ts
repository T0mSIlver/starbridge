/**
 * Decisions in the agent: posts them for local clients, keeps the machine's one answer long-poll
 * open, and hands each session the answers and default-time notices for the decisions it asked.
 * Everything lives in the CLI's state file, under its lock, so an agent restart loses nothing a
 * session has not confirmed, and the CLI's own path (no agent) reads the same state.
 */
import { type Directory, ProtocolError } from "@starbridge/protocol";
import { type Ctx, iso, session, UsageError } from "../context";
import {
  type AskInput,
  ackLines,
  nextDefaultMs,
  poll,
  postDecision,
  sessionLines,
  takeAnswer,
} from "../decisions";
import type { SessionEvent, Status } from "./api";
import { type Feature, HttpError, type Hub, holdSeconds, pause } from "./server";

/** The server holds each answer poll this long, at most, when no default time falls sooner. */
const POLL_SECONDS = 60;
/** Re-read the directory this often even when no answer came, to notice a revocation. */
const DIRECTORY_MS = 10 * 60_000;
const BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** How often an unpaired agent checks whether `starbridge pair` ran. */
const UNPAIRED_MS = 5_000;

export class Decisions implements Feature {
  /** When the last poll that reached the server returned; default notices wait for it. */
  private checkedUntil = Number.NEGATIVE_INFINITY;
  private lastOkAt: Date | undefined;
  private lastError: string | undefined;
  /** When the poll in flight returns at the latest, and how to cut it short. */
  private inflight: { endsAt: number; abort: AbortController } | undefined;

  constructor(private readonly hub: Hub) {}

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
        this.rearm();
        return { id: decision.id };
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
        return {
          ...(found ?? {}),
          ...(asked?.defaultAt ? { defaultAt: asked.defaultAt } : {}),
        };
      },
    },
  ];

  events(id: string): SessionEvent[] {
    const now = this.ctx.now().getTime();
    return sessionLines(this.ctx.store.state(), id, now, this.checkedUntil);
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

  /** Cuts the poll in flight short when a new decision's default time falls before it returns. */
  private rearm() {
    const due = nextDefaultMs(this.ctx.store.state(), this.ctx.now().getTime());
    if (this.inflight && due !== undefined && Date.now() + due < this.inflight.endsAt)
      this.inflight.abort.abort();
  }

  /**
   * One long-poll after another from the shared cursor. Each holds until an answer comes, or
   * until the next default time, so the notice goes out on time once the server confirmed no
   * answer is waiting.
   */
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
      const due = nextDefaultMs(st, this.ctx.now().getTime());
      const seconds = first
        ? 0
        : Math.min(POLL_SECONDS, due === undefined ? POLL_SECONDS : Math.ceil(due / 1000));
      const abort = new AbortController();
      const onStop = () => abort.abort();
      signal.addEventListener("abort", onStop);
      this.inflight = { endsAt: Date.now() + seconds * 1000, abort };
      try {
        if (directory && Date.now() - directory.at > DIRECTORY_MS) directory = undefined;
        const s = session(this.ctx);
        const r = await poll({ ...this.ctx, signal: abort.signal }, s, {
          cursor: st.cursor,
          seconds,
          shared: true,
          ...(directory ? { directory: directory.dir } : {}),
        });
        if (r.directory !== directory?.dir) directory = { dir: r.directory, at: Date.now() };
        this.checkedUntil = this.ctx.now().getTime();
        this.lastOkAt = this.ctx.now();
        if (this.lastError !== undefined) this.hub.log("server reachable again");
        this.lastError = undefined;
        failures = 0;
        first = false;
        this.hub.notify();
      } catch (e) {
        if (signal.aborted) break;
        // A new decision's default time comes sooner: poll again with a shorter hold.
        if (abort.signal.aborted) continue;
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
      } finally {
        signal.removeEventListener("abort", onStop);
        this.inflight = undefined;
      }
    }
  }
}
