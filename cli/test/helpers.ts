import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { Store } from "../src/config";
import type { Ctx } from "../src/context";
import type { FakeServer } from "./fake-server";

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

export async function until(pred: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** Runs `starbridge pair` and approves it from the fake server's phone. */
export async function paired(server: FakeServer): Promise<TestCtx> {
  const ctx = testCtx();
  const done = run(["pair", "--server", server.url, "--name", "devbox"], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  const code = ctx.lines[0]?.replace("Pairing code: ", "") as string;
  server.approve(code);
  if ((await done) !== 0) throw new Error(ctx.errors.join("\n"));
  ctx.lines.length = 0;
  return ctx;
}
