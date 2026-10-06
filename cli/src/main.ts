#!/usr/bin/env node
import { run } from "./cli";
import { configDir, Store } from "./config";
import type { Ctx } from "./context";
import { normalEnv } from "./platform";

const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
});
// systemd and launchd stop the agent with SIGTERM: it removes its socket on the way out.
process.on("SIGTERM", () => controller.abort());
/**
 * A reader that closed the pipe, such as `| head -1`, wants no more output: exit quietly with
 * the status SIGPIPE gives Unix tools (128 + 13). Bun throws EPIPE from the write, or emits it.
 */
function closedPipe(e: unknown): never {
  if ((e as { code?: unknown } | null)?.code === "EPIPE") process.exit(141);
  throw e;
}
for (const stream of [process.stdout, process.stderr]) stream.on("error", closedPipe);
const write = (stream: NodeJS.WriteStream, line: string) => {
  try {
    stream.write(`${line}\n`);
  } catch (e) {
    closedPipe(e);
  }
};
const env = normalEnv(process.env);
const ctx: Ctx = {
  env,
  store: new Store(configDir(env)),
  out: (l) => write(process.stdout, l),
  err: (l) => write(process.stderr, l),
  now: () => new Date(),
  sleep: (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(t);
        r();
      });
    }),
  signal: controller.signal,
};
try {
  process.exitCode = await run(process.argv.slice(2), ctx);
} catch (e) {
  // Never Bun's crash banner: a caller must see the command failed, and why (#548).
  ctx.err(`starbridge: ${(e as Error)?.message ?? String(e)}`);
  process.exitCode = 1;
}
