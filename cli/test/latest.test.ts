import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { Release } from "../src/agent/release";
import { run } from "../src/cli";
import { CHECK_EVERY_MS, checkLatest } from "../src/latest";
import { latestLine } from "../src/setup/status";
import { VERSION } from "../src/version";
import { paired, type TestCtx, testCtx } from "./helpers";

setDefaultTimeout(30_000);

/** GitHub's releases/latest, answering with `tag` and an ETag, 304 to that ETag. */
function fakeGitHub(tag = "v99.0.0") {
  const seen: (string | null)[] = [];
  let status = 200;
  const http = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req.headers.get("if-none-match"));
      if (status !== 200) return new Response("no", { status });
      if (req.headers.get("if-none-match") === `"${tag}"`)
        return new Response(null, { status: 304 });
      return Response.json({ tag_name: tag }, { headers: { etag: `"${tag}"` } });
    },
  });
  return {
    url: `http://localhost:${http.port}/latest`,
    seen,
    fail: (s: number) => {
      status = s;
    },
    stop: () => http.stop(true),
  };
}

let gh: ReturnType<typeof fakeGitHub>;
beforeEach(() => {
  gh = fakeGitHub();
});
afterEach(() => gh.stop());

test("the latest release is read at most once a day, with the saved ETag, and a failure keeps it (#1050)", async () => {
  const ctx = testCtx({ STARBRIDGE_LATEST_URL: gh.url });
  const t0 = new Date("2026-10-10T08:00:00Z");
  expect((await checkLatest(ctx, t0))?.version).toBe("99.0.0");
  await checkLatest(ctx, new Date(t0.getTime() + CHECK_EVERY_MS - 1));
  expect(gh.seen).toEqual([null]);
  const t1 = new Date(t0.getTime() + CHECK_EVERY_MS);
  expect(await checkLatest(ctx, t1)).toEqual({
    version: "99.0.0",
    etag: '"v99.0.0"',
    checkedAt: t1.toISOString(),
  });
  expect(gh.seen).toEqual([null, '"v99.0.0"']);
  gh.fail(500);
  const t2 = new Date(t1.getTime() + CHECK_EVERY_MS);
  expect((await checkLatest(ctx, t2))?.checkedAt).toBe(t1.toISOString());
  gh.stop();
  expect((await checkLatest(ctx, t2))?.version).toBe("99.0.0");
});

/** `ctx` as a person's terminal, after the agent read 99.0.0. */
async function behind(env: Record<string, string> = {}): Promise<TestCtx> {
  const ctx = { ...testCtx({ STARBRIDGE_LATEST_URL: gh.url, ...env }), terminal: true };
  await checkLatest(ctx);
  return ctx;
}

test("a command a person runs says a newer release is out, on stderr; agents' commands never (#1050)", async () => {
  const ctx = await behind();
  expect(await run(["--version"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([`starbridge ${VERSION}`]);
  // The tests run from source, as npm installs do.
  const line = `Starbridge 99.0.0 is out (you have ${VERSION}): run npm i -g starbridge@latest, then starbridge setup --refresh`;
  expect(ctx.errors).toEqual([line]);
  ctx.errors.length = 0;
  await run(["hook", "ask-user"], ctx);
  await run(["wait", "--timeout", "1s"], ctx);
  expect(ctx.errors.filter((l) => l.includes("is out"))).toEqual([]);
  // Not a terminal: a script or an agent runs it.
  await run(["--version"], { ...ctx, terminal: false });
  expect(ctx.errors).not.toContain(line);
});

test("config update-check off, or the env var, keeps it quiet (#1050)", async () => {
  const quiet = await behind({ STARBRIDGE_NO_UPDATE_CHECK: "1" });
  await run(["--version"], quiet);
  expect(quiet.errors).toEqual([]);

  const ctx = await behind();
  expect(await run(["config", "update-check", "off"], ctx)).toBe(0);
  expect(ctx.lines).toContain("update-check  off");
  expect(ctx.errors).toEqual([]);
  expect(await run(["config", "update-check", "on"], ctx)).toBe(0);
  expect(ctx.errors.at(-1)).toStartWith("Starbridge 99.0.0 is out");
});

test("the agent tells the server its release and the latest, so devices see it behind (#1050)", async () => {
  const server = await LiveServer.start();
  try {
    const ctx = await paired(server);
    ctx.env.STARBRIDGE_LATEST_URL = gh.url;
    const me = ctx.store.machine()?.id as string;
    const release = new Release({
      ctx,
      notify: () => {},
      changed: async () => {},
      log: () => {},
      seen: () => false,
    });
    await release.tick();
    expect(await server.releases()).toEqual({
      [me]: { version: VERSION, latest: "99.0.0", behind: true },
    });
    // Nothing changed: nothing sent.
    const puts = () => server.log.filter((l) => l === "PUT /release").length;
    await release.tick();
    expect(puts()).toBe(1);
    // Turned off: the machine no longer says what is latest, and GitHub hears nothing.
    await run(["config", "update-check", "off"], ctx);
    const asked = gh.seen.length;
    ctx.store.saveLatest({ checkedAt: "2026-01-01T00:00:00Z", version: "99.0.0" });
    await release.tick();
    expect(gh.seen.length).toBe(asked);
    expect((await server.releases())[me]).toEqual({
      version: VERSION,
      latest: null,
      behind: false,
    });
  } finally {
    server.stop();
  }
});

test("status shows the latest release, and what to run when it is newer (#1050)", async () => {
  const ctx = testCtx();
  expect(latestLine(ctx)).toBe("Latest: not checked yet (the agent reads it once a day)");
  ctx.env.STARBRIDGE_LATEST_URL = gh.url;
  await checkLatest(ctx);
  expect(latestLine(ctx)).toMatch(
    /^Latest: 99\.0\.0, checked .+: run npm i -g starbridge@latest, then starbridge setup --refresh$/,
  );
  ctx.env.STARBRIDGE_NO_UPDATE_CHECK = "1";
  expect(latestLine(ctx)).toBe("Latest: not checked (`starbridge config update-check on`)");
});

test("a stopping agent never waits on GitHub (#1050)", async () => {
  const stalled = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    const ctx = testCtx({ STARBRIDGE_LATEST_URL: `http://localhost:${stalled.port}/latest` });
    const hub = {
      ctx,
      notify: () => {},
      changed: async () => {},
      log: () => {},
      seen: () => false,
    };
    const stop = new AbortController();
    const loop = new Release(hub).run(stop.signal);
    await Bun.sleep(50);
    const t0 = Date.now();
    stop.abort();
    await loop;
    expect(Date.now() - t0).toBeLessThan(1_000);
  } finally {
    stalled.stop(true);
  }
});

test("an unreadable latest.json is moved aside and read again; an unreadable agent.json stops neither the check nor --version (#1050, #1174)", async () => {
  const ctx = { ...testCtx({ STARBRIDGE_LATEST_URL: gh.url }), terminal: true };
  writeFileSync(join(ctx.store.dir, "latest.json"), "{");
  writeFileSync(join(ctx.store.dir, "agent.json"), "{");
  const now = new Date("2026-10-11T08:00:00.000Z");
  expect((await checkLatest(ctx, now))?.version).toBe("99.0.0");
  expect(ctx.store.latest()?.version).toBe("99.0.0");
  expect(
    readFileSync(join(ctx.store.dir, "latest.json.unreadable-2026-10-11T08-00-00-000Z"), "utf8"),
  ).toBe("{");
  const hub = { ctx, notify: () => {}, changed: async () => {}, log: () => {}, seen: () => false };
  await new Release(hub).tick();
  expect(await run(["--version"], ctx)).toBe(0);
  expect(ctx.errors).toEqual([]);
});
