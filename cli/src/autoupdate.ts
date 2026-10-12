/**
 * Automatic updates (#1266): on a script install, the local agent runs `starbridge update` by
 * itself once a newer final is out, at a quiet moment. Here is when; `agent/autoupdate.ts` runs it.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import type { State, UpdateRecord } from "./config";
import type { Ctx } from "./context";
import { updateCheckOn } from "./latest";
import { resolveCommand } from "./platform";
import { compareVersions, type InstallKind } from "./release";
import { PLACES } from "./setup/service";

export const RETRY_MS = 24 * 3_600_000;
/** How long after the agent first sees a release it may wait, at random, before installing it. */
export const JITTER_MS = 2 * 3_600_000;
/** A question asked longer ago no longer holds an update: one forgotten card would stop them. */
export const QUESTION_HOLD_MS = 24 * 3_600_000;
/** Devices call a run lost after 3 minutes without news (spec/items.md, "Runs"). */
export const RUN_LOST_MS = 3 * 60_000;

/** Whether this install updates by itself: a script install, unless turned off. */
export function autoOn(ctx: Ctx, install: InstallKind): boolean {
  return (
    install.kind === "binary" &&
    ctx.store.agentConfig().updates?.auto !== false &&
    updateCheckOn(ctx)
  );
}

export type Decision = { install: string } | { wait: string; until?: Date } | { none: true };

/**
 * Whether to install `latest` now. `seenAt` is when this agent first saw `latest` and `jitterMs`
 * its random delay; `busy` what is in flight on the machine, if anything.
 */
export function decide(o: {
  now: Date;
  current: string;
  latest: string | undefined;
  record: UpdateRecord;
  seenAt: Date;
  jitterMs: number;
  busy: string | undefined;
}): Decision {
  if (!o.latest || compareVersions(o.latest, o.current) <= 0) return { none: true };
  const tried = o.record.tried ? Date.parse(o.record.tried.at) : Number.NaN;
  if (tried + RETRY_MS > o.now.getTime())
    return { wait: "tried in the last day", until: new Date(tried + RETRY_MS) };
  const due = o.seenAt.getTime() + o.jitterMs;
  if (due > o.now.getTime()) return { wait: "waiting its turn", until: new Date(due) };
  if (o.busy) return { wait: o.busy };
  return { install: o.latest };
}

/**
 * What is in flight on this machine that an update would cut short, if anything: an open
 * permission prompt, a question asked in the last day still open, or a run (`runs`).
 */
export function inFlight(st: State, now: Date, runs: number): string | undefined {
  const t = now.getTime();
  if (
    Object.values(st.permissions ?? {}).some(
      (p) => !p.settled && Date.parse(p.permission.expiresAt) > t,
    )
  )
    return "a permission prompt is open";
  if (
    Object.entries(st.asked).some(
      ([id, a]) => !a.settled && !st.answers[id] && Date.parse(a.askedAt) > t - QUESTION_HOLD_MS,
    )
  )
    return "a question is open";
  if (runs > 0) return runs === 1 ? "a run is in flight" : `${runs} runs are in flight`;
  return undefined;
}

/**
 * Starts `<binary> update` with its output in `update.log`, outside the agent's service: the
 * update's `setup --refresh` restarts the service, and the manager would stop a child with it.
 * Under systemd that means a transient unit of its own, with the agent's places; elsewhere
 * a detached process, which neither launchd nor Task Scheduler stops with the agent. Resolves
 * with why it could not start, or undefined once it has.
 */
export function launchUpdate(
  ctx: Ctx,
  binary: string,
  platform = process.platform,
): Promise<string | undefined> {
  const log = join(ctx.store.dir, "update.log");
  const env = ctx.env as NodeJS.ProcessEnv;
  const systemdRun = ctx.env.INVOCATION_ID ? resolveCommand(ctx.env, "systemd-run") : undefined;
  return new Promise((resolve) => {
    if (systemdRun) {
      // Without --wait, systemd-run exits once the unit has started.
      const args = [
        "--user",
        "--collect",
        "--quiet",
        // The user manager's environment, plus what the agent's unit and setup add to it.
        ...Object.keys(ctx.env)
          .filter((k) => k === "PATH" || PLACES.includes(k) || k.startsWith("STARBRIDGE_"))
          .flatMap((k) => ["-E", k]),
      ];
      const child = spawn(
        systemdRun,
        [...args, "--", "/bin/sh", "-c", 'exec "$0" update >"$1" 2>&1', binary, log],
        { env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      child.stderr?.on("data", (d) => {
        err += d;
      });
      child.on("error", (e) => resolve(`systemd-run: ${e.message}`));
      child.on("close", (code) =>
        resolve(code === 0 ? undefined : `systemd-run: ${err.trim() || `exit ${code}`}`),
      );
      return;
    }
    let fd: number;
    try {
      fd = openSync(log, "w", 0o600);
    } catch (e) {
      return resolve((e as Error).message);
    }
    const child = spawn(binary, ["update"], {
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: platform === "win32",
    });
    closeSync(fd);
    child.on("error", (e) => resolve(e.message));
    child.on("spawn", () => {
      child.unref();
      resolve(undefined);
    });
  });
}
