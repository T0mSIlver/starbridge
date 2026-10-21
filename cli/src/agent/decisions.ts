/**
 * Decisions in the agent: posts them for local clients, keeps the machine's one answer long-poll
 * open, posts their waiting state, and hands each session the answers to the decisions it asked.
 * Everything lives in the CLI's state file, under its lock, so an agent restart loses nothing a
 * session has not confirmed, and the CLI's own path (no agent) reads the same state.
 */
import { activeMembers, type Directory, ProtocolError } from "@starbridge/protocol";
import { type AgyRoute, agyReachable, agySend } from "../antigravity";
import {
  type CodexSession,
  codexNotice,
  codexQueue,
  codexReachable,
  codexSteer,
  trustedCodex,
} from "../codex";
import { type Ctx, iso, session, UsageError } from "../context";
import {
  ASK_CONTENT_FIELDS,
  ASK_ROUTE_FIELDS,
  ackLines,
  answerLine,
  deliverable,
  delivery,
  dropRevokedNow,
  MOD_SEEN_MS,
  observedAnswers,
  pickFields,
  poll,
  postDecision,
  postWaiting,
  sessionLines,
  snoozedUntil,
  steering,
  takeAnswer,
  takeSnooze,
  takeUnseen,
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
  /** Answers whose delivery failed, by decision id: tries so far, and when next. */
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
          throw new HttpError(400, "bad-request", "post {input: {question, ...}}");
        // A hook posts a held question, names a picker or opens a next-step card without the
        // agent: a client's word for those, or any other field, is dropped.
        const ask = pickFields(input, [...ASK_CONTENT_FIELDS, ...ASK_ROUTE_FIELDS]);
        // The asking process knows its directory; the agent's would name the wrong project.
        if (typeof ask.project !== "string")
          throw new HttpError(400, "bad-request", "input.project is required");
        const decision = await postDecision(this.ctx, session(this.ctx), ask);
        const codex = ask.codex && trustedCodex(this.ctx, ask.codex);
        const reachable = codex
          ? await codexReachable(codex)
          : ask.antigravity
            ? await agyReachable(ask.antigravity)
            : false;
        const mod =
          !!ask.session &&
          this.hub.seen(
            ask.session,
            ask.agent === "cursor" ? Number.POSITIVE_INFINITY : MOD_SEEN_MS,
          );
        const d = delivery(ask, reachable, mod);
        // A Codex session told to wait gets nothing queued into it, as promised (#2182): its
        // daemon was down at the ask, and `codex queue` would reach it once it came back.
        if (d === "wait" && ask.codex)
          this.ctx.store.updateState((st) => {
            delete st.asked[decision.id]?.codex;
          });
        return { id: decision.id, delivery: d };
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
        // A revoked device's answer is dropped first, as every hand-out does (#491).
        if (state === "waiting") await this.beforeEvents();
        const taken = state === "waiting" ? takeUnseen(this.ctx.store, id) : undefined;
        if (taken) return { posted: false, ...taken };
        const posted = await postWaiting(this.ctx, session(this.ctx), id, state);
        const until = snoozedUntil(this.ctx.store.state(), id, this.ctx.now());
        return { posted, ...(until ? { snoozedUntil: until } : {}) };
      },
    },
    {
      method: "POST",
      path: "/v1/answers/next",
      handle: async (req: { body: unknown; signal: AbortSignal }) => {
        const b = (req.body ?? {}) as { id?: unknown; session?: unknown; wait?: unknown };
        const id = typeof b.id === "string" ? b.id : undefined;
        // Without `session`, any session's answer.
        const from = typeof b.session === "string" ? b.session : undefined;
        const asked = id ? this.ctx.store.state().asked[id] : undefined;
        if (id && !asked)
          throw new HttpError(
            404,
            "unknown-decision",
            `${id} is not a decision this machine asked`,
          );
        const wait = holdSeconds(b.wait === undefined ? undefined : String(b.wait));
        const end = Date.now() + wait * 1000;
        await this.beforeEvents();
        // Without an answer, a decision's snooze, once per snooze (#571).
        const snoozed = () => {
          const until = id ? takeSnooze(this.ctx.store, id, this.ctx.now()) : undefined;
          return until ? { snoozedUntil: until, question: asked?.question } : undefined;
        };
        let found = takeAnswer(this.ctx.store, id, from);
        let off = found ? undefined : snoozed();
        while (!found && !off && Date.now() < end) {
          await this.hub.changed(end - Date.now(), req.signal);
          // Taking marks the answer seen: a client that hung up, as on a restart (#548), would
          // never print it, and its next wait would skip it.
          if (req.signal.aborted) return {};
          found = takeAnswer(this.ctx.store, id, from);
          if (!found) off = snoozed();
        }
        return found ?? off ?? {};
      },
    },
    {
      method: "POST",
      path: "/v1/answers/all",
      handle: async (req: { body: unknown; signal: AbortSignal }) => {
        const b = (req.body ?? {}) as { since?: unknown; known?: unknown; wait?: unknown };
        const since = typeof b.since === "number" ? b.since : undefined;
        if (
          b.known !== undefined &&
          !(Array.isArray(b.known) && b.known.every((k) => typeof k === "string"))
        )
          throw new HttpError(400, "bad-request", "known takes [decision id]");
        const known = new Set((b.known ?? []) as string[]);
        const wait = holdSeconds(b.wait === undefined ? undefined : String(b.wait));
        const end = Date.now() + wait * 1000;
        await this.beforeEvents();
        // An observer: it reads the answers and marks none seen, so each still reaches its session.
        let found = observedAnswers(this.ctx.store.state(), { since, known });
        while (found.length === 0 && !req.signal.aborted && Date.now() < end) {
          await this.hub.changed(end - Date.now(), req.signal);
          found = observedAnswers(this.ctx.store.state(), { since, known });
        }
        return { answers: found };
      },
    },
  ];

  /**
   * Drops the saved answers of a device revoked since, before one is handed out (#491): the
   * agent's poll drops them too, but not before its first round.
   */
  async beforeEvents() {
    await dropRevokedNow(this.ctx);
  }

  events(id: string): SessionEvent[] {
    const st = this.ctx.store.state();
    // An answer with a language-server route goes that way (`deliverQueued`); the Stop hook takes
    // it only once that gave up, or it would arrive twice (#1278).
    return sessionLines(st, id).filter(
      (l) =>
        !st.asked[l.decisionId]?.antigravity ||
        (this.retries.get(l.decisionId)?.tries ?? 0) >= CODEX_TRIES,
    );
  }

  ack(id: string, tokens: string[]): string[] {
    let acked: string[] = [];
    this.ctx.store.updateState((st) => {
      acked = ackLines(st, id, tokens);
    });
    return acked;
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
   * Steers the new answers to a Codex session into its running turn (#1486, #1584), or queues
   * them with `codex queue` when none runs, and sends those to an Antigravity conversation
   * through its language server (#961): the answers one session has waiting go as one message
   * (#1597). Marks them seen only once that succeeded: an agent that dies meanwhile delivers them
   * again, rather than never. A session that is gone gets CODEX_TRIES tries, a minute apart; the
   * answers stay for a `wait`.
   */
  private async deliverQueued() {
    const now = Date.now();
    const st = this.ctx.store.state();
    if (st.behind) return;
    /** The ids due, in the order the answers came, by the session and route they go to. */
    const due = new Map<string, string[]>();
    for (const [id, a] of Object.entries(st.answers)) {
      const asked = st.asked[id];
      const route = asked?.codex ?? asked?.antigravity;
      if (a.seen || !route || !asked?.session || !deliverable(st, id)) continue;
      const retry = this.retries.get(id) ?? { tries: 0, at: 0 };
      if (retry.tries >= CODEX_TRIES || retry.at > now) continue;
      const key = JSON.stringify([asked.codex ? "codex" : "agy", route, asked.session]);
      due.set(key, [...(due.get(key) ?? []), id]);
    }
    for (const ids of due.values()) await this.deliverTo(ids, now);
  }

  /** Delivers the answers to `ids`, one session's, as one message. */
  private async deliverTo(all: string[], now: number) {
    // Read again: another process may have found the directory behind meanwhile.
    if (this.ctx.store.state().behind) return;
    const first = this.ctx.store.state().asked[all[0] as string];
    if (!first?.session) return;
    const session = first.session;
    const [how, where] = first.codex
      ? ["codex queue", `Codex session ${session}`]
      : ["sending to Antigravity", `Antigravity conversation ${session}`];
    // Into the running turn, waiting or not; with none running, queued (#1584).
    const steered = first.codex ? await this.steer(all) : [];
    // Read again: a `waiting` printed one meanwhile, or a `settle` closed it during the steer or
    // an earlier session's delivery.
    const fresh = this.ctx.store.state();
    const ids = all.filter(
      (id) => !steered.includes(id) && !fresh.answers[id]?.seen && deliverable(fresh, id),
    );
    const done = (sent: string[], verb: string) => {
      for (const id of sent) this.retries.delete(id);
      this.ctx.store.updateState((st) => {
        for (const id of sent) {
          const x = st.answers[id];
          if (x) x.seen = true;
        }
      });
      this.hub.log(
        `${sent.length > 1 ? "answers" : "answer"} to ${sent.join(", ")} ${verb} into ${where}`,
      );
    };
    if (steered.length > 0) done(steered, "steered");
    if (ids.length === 0) return;
    const st = fresh;
    const codex = first.codex && trustedCodex(this.ctx, first.codex);
    const error = first.codex
      ? codex
        ? await codexQueue(codex, session, codexNotice(ids))
        : "its CODEX_HOME is not the one setup recorded"
      : await agySend(
          first.antigravity as AgyRoute,
          session,
          ids
            .map((id) => {
              const a = st.answers[id];
              return a ? answerLine(a.answer, st.asked[id]?.question) : "";
            })
            .filter(Boolean)
            .join("\n"),
        );
    if (error === undefined) return done(ids, "queued");
    for (const id of ids) {
      const tries = (this.retries.get(id)?.tries ?? 0) + 1;
      this.retries.set(id, { tries, at: now + CODEX_RETRY_MS });
      this.hub.log(
        tries < CODEX_TRIES
          ? `answer to ${id}: ${how} failed (${error}); retrying in 1 min`
          : `answer to ${id}: ${how} failed ${tries} times (${error}); giving up`,
      );
    }
  }

  /**
   * Steers the answers to `ids`, one Codex session's, into its running turn as one message
   * (#1486, #1597), and returns those it steered. Claimed under the lock first, so a `waiting`
   * meanwhile does not print one too. The claim is not `seen`: an agent that dies mid-steer leaves
   * one that expires, and delivers it again.
   */
  private async steer(ids: string[]): Promise<string[]> {
    const lines: string[] = [];
    const claimed: string[] = [];
    let route: { codex: CodexSession; session: string } | undefined;
    this.ctx.store.updateState((st) => {
      for (const id of ids) {
        const a = st.answers[id];
        const asked = st.asked[id];
        if (!a || a.seen || steering(a) || !asked?.codex || !asked.session) continue;
        if (!deliverable(st, id)) continue;
        a.steering = Date.now();
        lines.push(answerLine(a.answer, asked.question));
        claimed.push(id);
        route ??= { codex: asked.codex, session: asked.session };
      }
    });
    if (!route || claimed.length === 0) return [];
    const codex = trustedCodex(this.ctx, route.codex);
    const steered = !!codex && (await codexSteer(codex, route.session, lines.join("\n")));
    this.ctx.store.updateState((st) => {
      for (const id of claimed) {
        const a = st.answers[id];
        if (!a) continue;
        delete a.steering;
        if (steered) a.seen = true;
      }
    });
    return steered ? claimed : [];
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
        await this.deliverQueued();
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
