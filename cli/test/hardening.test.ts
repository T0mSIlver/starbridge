import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketPath } from "../src/agent/api";
import { Runs } from "../src/agent/runs";
import { hookPreTool } from "../src/antigravity";
import { decide, RETRY_MS } from "../src/autoupdate";
import { checkLatest } from "../src/latest";
import { linkIntoLocalBin, optDir } from "../src/setup/codexbar";
import { testCtx } from "./helpers";

let http: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  http?.stop(true);
  http = undefined;
});

test("a latest-release check dated in the future is read again, and a future failed try does not hold updates (#1763)", async () => {
  let reads = 0;
  http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      reads++;
      return Response.json({ tag_name: "v99.0.0" });
    },
  });
  const ctx = testCtx({ STARBRIDGE_LATEST_URL: `http://127.0.0.1:${http.port}/latest` });
  const now = new Date("2026-10-10T08:00:00Z");
  ctx.store.saveLatest({ checkedAt: "2999-01-01T00:00:00.000Z", version: "1.0.0" });
  expect((await checkLatest(ctx, now))?.version).toBe("99.0.0");
  expect(reads).toBe(1);

  const base = {
    now,
    current: "0.1.5",
    latest: "0.1.6",
    record: { tried: { at: "2999-01-01T00:00:00.000Z", version: "0.1.6" } },
    seenAt: new Date(now.getTime() - RETRY_MS),
    jitterMs: 0,
    busy: undefined,
  };
  expect(decide(base)).toEqual({ install: "0.1.6" });
});

test("another session cannot post updates under a run's id (#1763)", async () => {
  const ctx = testCtx();
  const runs = new Runs({
    ctx,
    notify: () => {},
    changed: async () => {},
    log: () => {},
    seen: () => false,
  } as never);
  const post = (session: string) =>
    (runs.routes[0] as (typeof runs.routes)[0]).handle({ body: { run: { id: "r1", session } } });
  // Not paired: the post itself fails, after the id was taken.
  await post("s1").catch(() => {});
  await post("s1").catch(() => {});
  await expect(post("s2")).rejects.toMatchObject({ status: 403 });
});

test("Antigravity's markers are dropped after a day, or when dated in the future (#1763)", () => {
  const ctx = testCtx();
  ctx.store.saveAgentConfig({ permissions: { enabled: true } });
  writeFileSync(socketPath(ctx.env, ctx.store.dir), "");
  const dir = join(ctx.store.dir, "antigravity");
  mkdirSync(dir, { recursive: true });
  const mark = (name: string, at: Date) => {
    writeFileSync(join(dir, name), "");
    utimesSync(join(dir, name), at, at);
  };
  mark("c-old", new Date(Date.now() - 2 * 86_400_000));
  mark("c-future", new Date(Date.now() + 5 * 86_400_000));
  mark("c-recent", new Date());
  // A command of a conversation that never said hello is denied once, and marks it.
  hookPreTool(
    ctx,
    JSON.stringify({
      conversationId: "c-new",
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
    }),
    { agent: "antigravity" },
  );
  expect(readdirSync(dir).sort()).toEqual(["c-new", "c-recent"]);
});

test("linkIntoLocalBin replaces its own link, and leaves one that points elsewhere (#1763)", () => {
  const home = mkdtempSync(join(tmpdir(), "starbridge-link-"));
  const sys = { home, ctx: testCtx() } as never;
  const bin = join(home, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const link = join(bin, "codexbar");
  const target = join(optDir(sys), "v2", "codexbar");
  symlinkSync(join(home, "brew", "codexbar"), link);
  expect(linkIntoLocalBin(sys, target)).toBeUndefined();
  expect(readlinkSync(link)).toBe(join(home, "brew", "codexbar"));
  unlinkSync(link);
  symlinkSync(join(optDir(sys), "v1", "codexbar"), link);
  expect(linkIntoLocalBin(sys, target)).toBe(link);
  expect(readlinkSync(link)).toBe(target);
});
