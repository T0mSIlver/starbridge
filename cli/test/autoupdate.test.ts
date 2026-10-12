import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AutoUpdate } from "../src/agent/autoupdate";
import { Runs } from "../src/agent/runs";
import {
  decide,
  inFlight,
  JITTER_MS,
  launchUpdate,
  RETRY_MS,
  RUN_LOST_MS,
} from "../src/autoupdate";
import { run } from "../src/cli";
import type { State } from "../src/config";
import { VERSION } from "../src/version";
import { testCtx, until } from "./helpers";

const WINDOWS = process.platform === "win32";
const now = new Date("2026-10-11T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const base = {
  now,
  current: "0.1.5",
  latest: "0.1.6",
  record: {},
  seenAt: ago(JITTER_MS),
  jitterMs: JITTER_MS,
  busy: undefined,
};

test("decide installs a newer release once its delay passed, a day after the last try, while nothing is in flight (#1266)", () => {
  expect(decide(base)).toEqual({ install: "0.1.6" });
  expect(decide({ ...base, latest: "0.1.5" })).toEqual({ none: true });
  expect(decide({ ...base, latest: undefined })).toEqual({ none: true });
  // Machines that read the release in the same hour spread their downloads.
  expect(decide({ ...base, seenAt: ago(JITTER_MS - 1) })).toEqual({
    wait: "waiting its turn",
    until: new Date(now.getTime() + 1),
  });
  // A failed try comes back a day later, not every look.
  const tried = { tried: { at: ago(RETRY_MS - 60_000).toISOString(), version: "0.1.6" } };
  expect(decide({ ...base, record: tried })).toMatchObject({ wait: "tried in the last day" });
  const dayOld = { tried: { at: ago(RETRY_MS).toISOString(), version: "0.1.6" } };
  expect(decide({ ...base, record: dayOld })).toEqual({ install: "0.1.6" });
  expect(decide({ ...base, busy: "a run is in flight" })).toEqual({ wait: "a run is in flight" });
});

test("inFlight holds for an open prompt, a question open since yesterday at most, and runs (#1266)", () => {
  const st = (s: Partial<State>): State => ({ asked: {}, answers: {}, ...s });
  const asked = (askedAt: Date, extra = {}) => ({
    question: "Ship it?",
    options: ["Yes", "No"],
    askedAt: askedAt.toISOString(),
    to: ["d1"],
    ...extra,
  });
  expect(inFlight(st({}), now, 0)).toBeUndefined();
  expect(inFlight(st({}), now, 1)).toBe("a run is in flight");
  expect(inFlight(st({}), now, 2)).toBe("2 runs are in flight");
  expect(inFlight(st({ asked: { q1: asked(ago(60_000)) } }), now, 0)).toBe("a question is open");
  // A card forgotten for over a day, answered or settled, holds nothing.
  expect(inFlight(st({ asked: { q1: asked(ago(25 * 3_600_000)) } }), now, 0)).toBeUndefined();
  expect(
    inFlight(st({ asked: { q1: asked(ago(60_000), { settled: true }) } }), now, 0),
  ).toBeUndefined();
  const answered = st({ asked: { q1: asked(ago(60_000)) } });
  answered.answers.q1 = {} as State["answers"][string];
  expect(inFlight(answered, now, 0)).toBeUndefined();
  const prompt = (expiresAt: Date, settled = false) =>
    ({ settled, permission: { expiresAt: expiresAt.toISOString() } }) as unknown as NonNullable<
      State["permissions"]
    >[string];
  const later = new Date(now.getTime() + 60_000);
  expect(inFlight(st({ permissions: { p1: prompt(later) } }), now, 0)).toBe(
    "a permission prompt is open",
  );
  expect(inFlight(st({ permissions: { p1: prompt(later, true) } }), now, 0)).toBeUndefined();
  expect(inFlight(st({ permissions: { p1: prompt(ago(1)) } }), now, 0)).toBeUndefined();
});

function hub(ctx: ReturnType<typeof testCtx>) {
  const log: string[] = [];
  return {
    log,
    hub: {
      ctx,
      notify: () => {},
      changed: async () => {},
      log: (l: string) => log.push(l),
      seen: () => false,
    },
  };
}

test("the agent starts `starbridge update` on a script install once due, and records the try (#1266)", async () => {
  const ctx = testCtx();
  let clock = now;
  ctx.now = () => clock;
  const { hub: h } = hub(ctx);
  const launched: string[] = [];
  let fail: string | undefined;
  let runs = 0;
  const auto = new AutoUpdate(h, () => runs, {
    install: () => ({ kind: "binary", path: "/opt/bin/starbridge" }),
    launch: async (_ctx, binary) => {
      launched.push(binary);
      return fail;
    },
    random: () => 0.5,
  });
  const status = () => {
    const into = {} as Parameters<AutoUpdate["status"]>[0];
    auto.status(into);
    return into.update;
  };
  // Up to date: nothing to do or say.
  await auto.tick();
  expect([launched, status()]).toEqual([[], undefined]);

  ctx.store.saveLatest({ checkedAt: now.toISOString(), version: "99.0.0" });
  await auto.tick();
  expect(launched).toEqual([]);
  expect(status()).toStartWith("99.0.0 waiting its turn, until ");
  // Its turn comes while a run is in flight: it waits for the run.
  clock = new Date(now.getTime() + JITTER_MS / 2);
  runs = 1;
  await auto.tick();
  expect(status()).toBe("99.0.0 a run is in flight");
  runs = 0;
  fail = "systemd-run: Failed to start transient service unit";
  await auto.tick();
  expect(launched).toEqual(["/opt/bin/starbridge"]);
  expect(ctx.store.updates()).toEqual({
    tried: { at: clock.toISOString(), version: "99.0.0" },
    failed: { at: clock.toISOString(), version: "99.0.0", why: fail },
  });
  // The next try comes a day later.
  await auto.tick();
  expect(launched).toHaveLength(1);
  expect(status()).toStartWith("99.0.0 tried in the last day, until ");
  clock = new Date(clock.getTime() + RETRY_MS);
  fail = undefined;
  await auto.tick();
  expect(launched).toHaveLength(2);
  expect(status()).toBe("started the update to 99.0.0");
});

test("the agent leaves Homebrew installs, and script installs with updates off, to the nudge (#1266)", async () => {
  const ctx = testCtx();
  ctx.store.saveLatest({ checkedAt: new Date().toISOString(), version: "99.0.0" });
  const launched: string[] = [];
  const make = (kind: "brew" | "binary") =>
    new AutoUpdate(hub(ctx).hub, () => 0, {
      install: () =>
        kind === "brew" ? { kind: "brew" } : { kind: "binary", path: "/opt/bin/starbridge" },
      launch: async (_ctx, binary) => {
        launched.push(binary);
        return undefined;
      },
      random: () => 0,
    });
  await make("brew").tick();
  expect(await run(["config", "updates", "off"], ctx)).toBe(0);
  expect(ctx.lines).toContain("updates       through npm");
  await make("binary").tick();
  expect(await run(["config", "updates", "on"], ctx)).toBe(0);
  ctx.env.STARBRIDGE_NO_UPDATE_CHECK = "1";
  await make("binary").tick();
  expect(launched).toEqual([]);
  delete ctx.env.STARBRIDGE_NO_UPDATE_CHECK;
  await make("binary").tick();
  expect(launched).toEqual(["/opt/bin/starbridge"]);
});

test("a run counts as in flight until its exit, or 3 minutes without news (#1266)", async () => {
  const ctx = testCtx();
  let clock = now;
  ctx.now = () => clock;
  const runs = new Runs(hub(ctx).hub);
  const post = (r: object) =>
    runs.routes[0]?.handle({ body: { run: { id: "r1", ...r } } }).catch(() => {});
  // Not paired: the post fails, and the run still runs here.
  await post({});
  expect(runs.inFlight()).toBe(1);
  clock = new Date(now.getTime() + RUN_LOST_MS + 1);
  expect(runs.inFlight()).toBe(0);
  await post({});
  await post({ exit: { code: 0, at: clock.toISOString() } });
  expect(runs.inFlight()).toBe(0);
});

test.skipIf(WINDOWS)(
  "launchUpdate starts `<binary> update` apart from the agent, its output in update.log (#1266)",
  async () => {
    const ctx = testCtx({ PATH: process.env.PATH ?? "" });
    const binary = join(ctx.store.dir, "starbridge");
    const done = join(ctx.store.dir, "done");
    writeFileSync(binary, `#!/bin/sh\necho "starbridge $1"\necho "$1" > "${done}"\n`);
    chmodSync(binary, 0o755);
    expect(await launchUpdate(ctx, binary)).toBeUndefined();
    await until(() => existsSync(done));
    await until(() => readFileSync(join(ctx.store.dir, "update.log"), "utf8") !== "");
    expect(readFileSync(join(ctx.store.dir, "update.log"), "utf8")).toBe("starbridge update\n");
    expect(await launchUpdate(ctx, join(ctx.store.dir, "missing"))).toContain("ENOENT");
  },
);

test("status names the setting, the last update and the last failure (#1266)", async () => {
  const { updateLines } = await import("../src/setup/status");
  const ctx = testCtx();
  const binary = { kind: "binary", path: "/opt/bin/starbridge" } as const;
  expect(updateLines(ctx, binary)).toEqual([
    "Updates: automatic (`starbridge config updates off`)",
  ]);
  expect(updateLines(ctx, { kind: "brew" })).toEqual([
    "Updates: through brew (brew upgrade starbridge, then starbridge setup --refresh)",
  ]);
  ctx.store.recordUpdate((r) => {
    r.tried = { at: "2026-10-11T12:00:00.000Z", version: "99.0.0" };
    r.updated = { at: "2026-10-01T09:00:00.000Z", from: "0.1.4", to: VERSION };
    r.failed = { at: "2026-10-11T12:00:01.000Z", version: "99.0.0", why: "offline" };
  });
  expect(updateLines(ctx, binary)).toEqual([
    "Updates: automatic (`starbridge config updates off`)",
    `  Last update: 0.1.4 to ${VERSION}, 2026-10-01T09:00:00.000Z`,
    `  Last failure: 2026-10-11T12:00:01.000Z (99.0.0): offline; tries again after 2026-10-12T12:00:00.000Z; output in ${join(ctx.store.dir, "update.log")}`,
  ]);
  ctx.store.saveAgentConfig({ updates: { auto: false } });
  expect(updateLines(ctx, binary)[0]).toBe("Updates: off (`starbridge config updates on`)");
});
