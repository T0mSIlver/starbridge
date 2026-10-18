// What `pair` does with the terminal when the check code needs the owner's word, followed by the
// next setup question (#2036). The answer comes from the terminal or, with a folder argument, from
// `starbridge pair --confirm` in another terminal.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/config";
import { confirmCheck, sendConfirm } from "../../src/pair";
import { terminalPrompt } from "../../src/setup/sys";

const controller = new AbortController();
// As `main.ts` does.
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
});
const dir = mkdtempSync(join(tmpdir(), "starbridge-tty-"));
const ctx = {
  env: {},
  store: new Store(dir),
  out: (l: string) => console.log(l),
  err: (l: string) => console.error(l),
  now: () => new Date(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  signal: controller.signal,
};
if (process.argv[2] === "elsewhere")
  setTimeout(() => sendConfirm({ ...ctx, out: () => {} }, true), 2000);
const check = await confirmCheck(ctx, "AAAA-AAAA-AAAA-AAAA", "devbox");
console.log(`check=${check}`);
if (controller.signal.aborted) process.exit(130);
const a = await terminalPrompt().text("Providers?", "none");
console.log(`answer=${a}`);
