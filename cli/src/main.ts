#!/usr/bin/env node
import { run } from "./cli";
import { configDir, Store } from "./config";
import type { Ctx } from "./context";

const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
});
const ctx: Ctx = {
  env: process.env,
  store: new Store(configDir(process.env)),
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
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
process.exitCode = await run(process.argv.slice(2), ctx);
