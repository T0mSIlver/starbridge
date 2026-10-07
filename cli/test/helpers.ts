import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveServer } from "@starbridge/server/test-support";
import { run } from "../src/cli";
import { Store } from "../src/config";
import type { Ctx } from "../src/context";
import { sendConfirm } from "../src/pair";

export const FAKE_CODEXBAR = join(import.meta.dir, "fixtures", "fake-codexbar.sh");

export interface TestCtx extends Ctx {
  lines: string[];
  errors: string[];
}

export function testCtx(env: Record<string, string> = {}): TestCtx {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    env,
    store: new Store(mkdtempSync(join(tmpdir(), "starbridge-cli-"))),
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    lines,
    errors,
  };
}

export async function until(pred: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** Runs `starbridge pair` and approves it from the owner's phone. */
export async function paired(server: LiveServer, name = "devbox"): Promise<TestCtx> {
  const ctx = testCtx();
  const done = run(["pair", "--server", server.url, "--name", name], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  await approveAndConfirm(server, ctx);
  if ((await done) !== 0) throw new Error(ctx.errors.join("\n"));
  ctx.lines.length = 0;
  return ctx;
}

/**
 * Approves, as the owner's phone, the pairing whose code `ctx` printed, then types the last group
 * of the check code the phone shows, as `starbridge pair --confirm` does.
 */
export async function approveAndConfirm(server: LiveServer, ctx: TestCtx, group?: string) {
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  const code = ctx.lines.findLast((l) => l.startsWith("Pairing code: "))?.slice(14) as string;
  const check = await server.approve(code);
  await until(() => ctx.lines.some((l) => l.startsWith("Check code: ")));
  sendConfirm({ ...ctx, out: () => {} }, group ?? check.slice(-4));
}
