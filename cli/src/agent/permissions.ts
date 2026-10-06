/**
 * Permission prompts in the agent (#57): `starbridge hook permission` posts its prompt here and
 * waits here, held requests of at most MAX_HOLD_SECONDS each. Answers come in through the answer
 * long-poll the decisions feature keeps open, which checks them and records them in the state;
 * a hold hands the answer out as the hook's output once, marking the prompt settled first.
 */
import { PermissionAgent } from "@starbridge/protocol";
import { type Ctx, session } from "../context";
import {
  hookDecision,
  markSettled,
  outcomeOf,
  type PermissionHookInput,
  type PermissionSourceInput,
  permissionsEnabled,
  postPermission,
  postSettled,
  waitingFor,
} from "../permissions";
import type { Status } from "./api";
import { type Feature, HttpError, type Hub, holdSeconds, type Request } from "./server";

/** What `POST /v1/permissions/:id/wait` returns. */
export interface PermissionWait {
  /** The hook's stdout for an accepted answer; given out once. */
  output?: unknown;
  /** How the prompt ended without an answer the hook may apply. */
  settled?: "keyboard" | "timeout" | "device";
}

/**
 * How long a prompt whose hook hung up mid-hold waits for its next hold before it counts as
 * answered at the keyboard: the hook died with its agent (a closed terminal, a crash), and an
 * answer from the devices would reach nobody.
 */
export const GONE_MS = 5_000;

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export class Permissions implements Feature {
  /** The holds open on each prompt. */
  private readonly holds = new Map<string, number>();

  constructor(private readonly hub: Hub) {}

  private get ctx(): Ctx {
    return this.hub.ctx;
  }

  /** Posts the settled notice in the background; the hook does not wait for it. */
  private report(id: string, how: ReturnType<typeof markSettled>) {
    if (!how) return;
    postSettled(this.ctx, session(this.ctx), id, how).catch((e) =>
      this.hub.log(`permission ${id}: could not report it settled: ${(e as Error).message}`),
    );
  }

  routes = [
    {
      method: "POST",
      path: "/v1/permissions",
      handle: async (req: Request) => {
        if (!permissionsEnabled(this.ctx))
          throw new HttpError(403, "disabled", "run `starbridge config permissions on` first");
        const b = obj(req.body);
        const agent = PermissionAgent.safeParse(b.agent);
        const source = obj(b.source);
        if (!agent.success)
          throw new HttpError(400, "bad-request", "agent is claude-code, codex or pi");
        if (typeof source.project !== "string" || typeof source.session !== "string")
          throw new HttpError(400, "bad-request", "source needs project and session");
        const waitMs = typeof b.waitMs === "number" ? b.waitMs : 0;
        const id = await postPermission(
          this.ctx,
          session(this.ctx),
          obj(b.hook) as PermissionHookInput,
          { agent: agent.data, source: source as unknown as PermissionSourceInput, waitMs },
          // The hook gives up at its deadline, or when the keyboard answers and it hangs up.
          AbortSignal.any([req.signal, AbortSignal.timeout(Math.max(1000, waitMs))]),
        );
        return { id };
      },
    },
    {
      method: "POST",
      path: "/v1/permissions/:id/wait",
      handle: async (req: Request): Promise<PermissionWait> => {
        const id = req.params.id ?? "";
        const b = obj(req.body);
        const wait = holdSeconds(b.wait === undefined ? undefined : String(b.wait));
        const end = Date.now() + wait * 1000;
        if (!this.ctx.store.state().permissions?.[id])
          throw new HttpError(
            404,
            "unknown-permission",
            `${id} is not a prompt this machine asked`,
          );
        this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
        try {
          return await this.hold(id, end, req.signal);
        } finally {
          const left = (this.holds.get(id) ?? 1) - 1;
          if (left > 0) this.holds.set(id, left);
          else this.holds.delete(id);
          if (req.signal.aborted && Date.now() < end) this.hungUp(id);
        }
      },
    },
    {
      method: "POST",
      path: "/v1/permissions/:id/settle",
      handle: async (req: Request) => {
        const id = req.params.id ?? "";
        const outcome = obj(req.body).outcome;
        if (outcome !== "keyboard" && outcome !== "timeout")
          throw new HttpError(400, "bad-request", "outcome is keyboard or timeout");
        const how = markSettled(this.ctx, id, outcome);
        this.report(id, how);
        this.hub.notify();
        return { settled: how !== undefined };
      },
    },
    {
      method: "POST",
      path: "/v1/sessions/:id/permissions/settle",
      handle: async (req: Request) => {
        const b = obj(req.body);
        const inputHash = typeof b.inputHash === "string" ? b.inputHash : undefined;
        return { settled: this.settleSession(req.params.id ?? "", inputHash) };
      },
    },
  ];

  /** Settles the waiting prompts of `session` as answered at the keyboard. */
  private settleSession(sessionId: string, inputHash?: string): string[] {
    const ids = waitingFor(this.ctx.store.state(), sessionId, inputHash);
    const done = ids.filter((id) => {
      const how = markSettled(this.ctx, id, "keyboard");
      this.report(id, how);
      return how !== undefined;
    });
    if (done.length > 0) this.hub.notify();
    return done;
  }

  /** One hold on prompt `id`, until an answer, a settle, `end` or the hook hanging up. */
  private async hold(id: string, end: number, signal: AbortSignal): Promise<PermissionWait> {
    while (true) {
      const p = this.ctx.store.state().permissions?.[id];
      const out = outcomeOf(p);
      // Behind on the directory, the answer may be a revoked device's: it waits.
      if (out.answer && p && !p.settled && !this.ctx.store.state().behind) {
        const how = markSettled(this.ctx, id, "device");
        // Another hold took it in between: the prompt is settled, nothing to hand out.
        if (!how) return { settled: "device" };
        this.report(id, how);
        return { output: hookDecision(p) };
      }
      if (out.settled) return { settled: out.settled };
      if (signal.aborted || Date.now() >= end) return {};
      await this.hub.changed(end - Date.now(), signal);
    }
  }

  /** The hook hung up mid-hold: unless it holds again soon, it is gone. */
  private hungUp(id: string) {
    setTimeout(() => {
      if (this.holds.has(id)) return;
      const how = markSettled(this.ctx, id, "keyboard");
      if (!how) return;
      this.hub.log(`permission ${id}: its hook hung up; settled at the keyboard`);
      this.report(id, how);
      this.hub.notify();
    }, GONE_MS).unref();
  }

  bye(sessionId: string) {
    this.settleSession(sessionId);
  }

  status(into: Status) {
    const waiting = Object.values(this.ctx.store.state().permissions ?? {}).filter(
      (p) => !p.settled,
    ).length;
    into.permissions = { enabled: permissionsEnabled(this.ctx), waiting };
  }
}
