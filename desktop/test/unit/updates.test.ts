import { expect, test } from "bun:test";
import {
  type Engine,
  parseUpdateAction,
  parseUpdateSettings,
  type UpdateSettings,
  type UpdateStatus,
  Updates,
} from "../../src/updates";

/** An engine the test drives: `found` is what a check finds, each download waits for `finish`. */
function setup(found: string | null, settings: UpdateSettings) {
  const told: UpdateStatus[] = [];
  const runs: { progress(p: number): void; finish(e?: Error): void; cancelled: boolean }[] = [];
  let installs = 0;
  const engine: Engine = {
    find: async () => found,
    download(progress) {
      let finish!: (e?: Error) => void;
      const done = new Promise<void>((ok, fail) => {
        finish = (e) => (e ? fail(e) : ok());
      });
      const run = { progress, finish, cancelled: false };
      runs.push(run);
      return {
        done,
        cancel: () => {
          run.cancelled = true;
          finish(new Error("cancelled"));
        },
      };
    },
    install: () => {
      installs++;
    },
  };
  const updates = new Updates(
    engine,
    () => settings,
    (s) => told.push(s),
  );
  return { updates, engine, told, runs, installs: () => installs };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("found, downloaded with its progress, then ready to restart", async () => {
  const { updates, told, runs, installs } = setup("0.2.0", {
    releaseCandidates: false,
    autoDownload: true,
  });
  updates.act("install");
  expect(installs()).toBe(0);
  await updates.check();
  runs[0]?.progress(41.7);
  runs[0]?.progress(41.9);
  runs[0]?.finish();
  await tick();
  expect(told).toEqual([
    { state: "checking" },
    { state: "available", version: "0.2.0" },
    { state: "downloading", version: "0.2.0", percent: 0 },
    { state: "downloading", version: "0.2.0", percent: 41 },
    { state: "ready", version: "0.2.0" },
  ]);
  await updates.check();
  expect(told).toHaveLength(5);
  updates.act("install");
  expect(installs()).toBe(1);
});

test("with automatic downloads off, the owner's click downloads", async () => {
  const { updates, runs } = setup("0.2.0", { releaseCandidates: false, autoDownload: false });
  await updates.check();
  expect(updates.status).toEqual({ state: "available", version: "0.2.0" });
  expect(runs).toHaveLength(0);
  updates.act("download");
  expect(updates.status.state).toBe("downloading");
});

test("a failed download says why, and the next check starts over", async () => {
  const { updates, runs } = setup("0.2.0", { releaseCandidates: false, autoDownload: true });
  await updates.check();
  runs[0]?.finish(new Error("Could not get code signature"));
  await tick();
  expect(updates.status).toEqual({ state: "error", message: "Could not get code signature" });
  await updates.check();
  expect(updates.status.state).toBe("downloading");
});

test("nothing newer, or a check that fails, leaves the button hidden", async () => {
  const none = setup(null, { releaseCandidates: false, autoDownload: true });
  await none.updates.check();
  expect(none.updates.status).toEqual({ state: "idle" });
  const offline = setup(null, { releaseCandidates: false, autoDownload: true });
  offline.engine.find = async () => {
    throw new Error("offline");
  };
  await offline.updates.check();
  expect(offline.updates.status).toEqual({ state: "idle" });
});

test("turning release candidates off cancels an rc download, not a downloaded one", async () => {
  const settings = { releaseCandidates: true, autoDownload: true };
  const { updates, engine, runs } = setup("0.2.0-rc.1", settings);
  await updates.check();
  settings.releaseCandidates = false;
  engine.find = async () => null;
  await updates.check();
  expect(runs[0]?.cancelled).toBe(true);
  await tick();
  expect(updates.status).toEqual({ state: "idle" });

  settings.releaseCandidates = true;
  engine.find = async () => "0.2.0-rc.1";
  await updates.check();
  runs[1]?.finish();
  await tick();
  settings.releaseCandidates = false;
  await updates.check();
  expect(updates.status).toEqual({ state: "ready", version: "0.2.0-rc.1" });
});

test("a newer release found after a download replaces it; the same one changes nothing", async () => {
  const { updates, engine, told, runs } = setup("0.1.6-rc.1", {
    releaseCandidates: true,
    autoDownload: true,
  });
  await updates.check();
  runs[0]?.finish();
  await tick();
  expect(updates.status).toEqual({ state: "ready", version: "0.1.6-rc.1" });
  const before = told.length;
  await updates.check();
  expect(told).toHaveLength(before);
  expect(runs).toHaveLength(1);

  engine.find = async () => "0.1.6-rc.2";
  await updates.check();
  // No "checking" in between: Restart to update stays until the newer download starts.
  expect(told.slice(before)).toEqual([
    { state: "available", version: "0.1.6-rc.2" },
    { state: "downloading", version: "0.1.6-rc.2", percent: 0 },
  ]);
  runs[1]?.finish();
  await tick();
  expect(updates.status).toEqual({ state: "ready", version: "0.1.6-rc.2" });
});

test("an offered release gives way to a newer one, and a click during the check gets the newer", async () => {
  const { updates, engine, runs } = setup("0.1.6-rc.1", {
    releaseCandidates: true,
    autoDownload: false,
  });
  await updates.check();
  expect(updates.status).toEqual({ state: "available", version: "0.1.6-rc.1" });
  let found!: (v: string) => void;
  engine.find = () => new Promise((r) => (found = r));
  const checking = updates.check();
  expect(updates.status).toEqual({ state: "available", version: "0.1.6-rc.1" });
  updates.act("download");
  expect(runs).toHaveLength(0);
  found("0.1.6-rc.2");
  await checking;
  expect(updates.status).toEqual({ state: "downloading", version: "0.1.6-rc.2", percent: 0 });
  expect(runs).toHaveLength(1);
});

test("a downloaded update stays when a check finds nothing newer or fails", async () => {
  const { updates, engine, runs } = setup("0.1.6-rc.2", {
    releaseCandidates: true,
    autoDownload: true,
  });
  await updates.check();
  runs[0]?.finish();
  await tick();
  for (const find of [
    async () => null,
    async () => "0.1.6-rc.1",
    async () => {
      throw new Error("offline");
    },
  ]) {
    engine.find = find;
    await updates.check();
    expect(updates.status).toEqual({ state: "ready", version: "0.1.6-rc.2" });
  }
});

test("the page's requests are read strictly", () => {
  expect(parseUpdateAction("download")).toBe("download");
  expect(parseUpdateAction("quit")).toBeNull();
  expect(parseUpdateSettings({ autoDownload: false })).toEqual({ autoDownload: false });
  expect(parseUpdateSettings({ releaseCandidates: true, server: "x" })).toEqual({
    releaseCandidates: true,
  });
  expect(parseUpdateSettings({ autoDownload: "no" })).toBeNull();
  expect(parseUpdateSettings({})).toBeNull();
  expect(parseUpdateSettings(null)).toBeNull();
});

test("settings changed during a check count for its answer", async () => {
  const settings = { releaseCandidates: true, autoDownload: true };
  const { updates, engine, runs } = setup(null, settings);
  engine.find = async (rcs) => {
    // The owner turns both off while the first lookup runs.
    settings.releaseCandidates = false;
    settings.autoDownload = false;
    return rcs ? "0.2.0-rc.1" : "0.1.9";
  };
  await updates.check();
  expect(updates.status).toEqual({ state: "available", version: "0.1.9" });
  expect(runs).toHaveLength(0);
});
