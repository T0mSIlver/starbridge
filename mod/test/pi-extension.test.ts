import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import starbridge from "../pi/starbridge.ts";

const STALE = "This extension ctx is stale after session replacement or reload.";

/** Pi's `pi` and `ctx`, whose getters and methods throw once Pi replaced the session, as Pi's do. */
function fakePi() {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
  const stale = { pi: false, ctx: false };
  const touched: string[] = [];
  const guard = (what: string, isStale: () => boolean) => {
    if (isStale()) {
      touched.push(what);
      throw new Error(STALE);
    }
  };
  const pi = {
    on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    sendUserMessage: () => guard("sendUserMessage", () => stale.pi),
    events: { on: () => () => {} },
  };
  const ui = { setStatus: () => {}, notify: () => {}, select: async () => undefined };
  const ctx = {
    get hasUI() {
      guard("hasUI", () => stale.ctx);
      return true;
    },
    get cwd() {
      guard("cwd", () => stale.ctx);
      return "/work";
    },
    get sessionManager() {
      guard("sessionManager", () => stale.ctx);
      return { getSessionId: () => "s1", getSessionFile: () => undefined };
    },
    get ui() {
      guard("ui", () => stale.ctx);
      return ui;
    },
  };
  return { pi, ctx, handlers, stale, touched };
}

test("the extension never touches a replaced session's ctx, so Pi keeps running (#1365)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-pi-"));
  // A CLI that hands over one answer once the test says so, after Pi replaced the session.
  const cli = join(dir, "starbridge");
  writeFileSync(
    cli,
    `#!/bin/sh
case "$*" in *--ack*) exit 0;; esac
touch "${dir}/started"
while [ ! -f "${dir}/go" ]; do sleep 0.02; done
echo '{"decisionId":"d1","ack":"d1","line":"Answer to d1: Merge"}'
touch "${dir}/printed"
`,
  );
  chmodSync(cli, 0o755);
  writeFileSync(join(dir, "cli-path"), cli);
  const saved = {
    dir: process.env.STARBRIDGE_CONFIG_DIR,
    noAgent: process.env.STARBRIDGE_NO_AGENT,
  };
  process.env.STARBRIDGE_CONFIG_DIR = dir;
  process.env.STARBRIDGE_NO_AGENT = "1";
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const until = async (file: string) => {
    const by = Date.now() + 5000;
    while (!existsSync(join(dir, file)) && Date.now() < by) await Bun.sleep(10);
    expect(existsSync(join(dir, file))).toBe(true);
  };
  try {
    const { pi, ctx, handlers, stale, touched } = fakePi();
    starbridge(pi as unknown as Parameters<typeof starbridge>[0]);
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    await until("started");
    // `/new`: Pi ends the session, then makes its `pi` and `ctx` throw, while the CLI still runs.
    await handlers.get("session_shutdown")?.({ reason: "new" }, ctx);
    stale.pi = true;
    stale.ctx = true;
    writeFileSync(join(dir, "go"), "");
    await until("printed");
    await Bun.sleep(200);
    expect(touched).toEqual([]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    for (const [key, value] of [
      ["STARBRIDGE_CONFIG_DIR", saved.dir],
      ["STARBRIDGE_NO_AGENT", saved.noAgent],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
