/**
 * Does Antigravity run a message sent with a given delivery strategy inside the turn that is
 * running, or after it (#1599)?
 *
 *   bun evals/antigravity-delivery.ts NEXT_INVOCATION   # or WHEN_IDLE, as the control
 *
 * Starts `agy -i` in tmux, with the eval login, on a turn of four 15 s commands. The first writes the
 * language server's address and token to a file. The probe reads it, sends the message while the
 * second command runs, and prints when the message's command ran against the four commands and the
 * end of the turn. Run one at a time: the login is shared. Spends the owner's Antigravity quota.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lsCall } from "../cli/src/antigravity";

const strategy = process.argv[2] ?? "NEXT_INVOCATION";
const home = process.env.AGY_EVAL_HOME ?? join(homedir(), ".config/starbridge/secrets/agy-eval-home");
const dir = join(process.env.TMPDIR ?? "/var/tmp", `agy-delivery-${strategy}-${Date.now()}`);
const session = `agy-delivery-${process.pid}`;
mkdirSync(join(dir, "proj"), { recursive: true });
const proj = join(dir, "proj");
const t = () => (Date.now() / 1000).toFixed(1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a: string[]) => spawnSync("tmux", a, { encoding: "utf8" });

const prompt =
  "Run these shell commands one after another, each in its own tool call, in this folder. " +
  "1: `env | grep ^ANTIGRAVITY_ > route.env; sleep 15; echo c1 $(date +%s.%N) >> log`. " +
  "2: `sleep 15; echo c2 $(date +%s.%N) >> log`. 3: the same with c3. 4: the same with c4. " +
  "Then reply with the word finished and nothing else.";

tmux("new-session", "-d", "-s", session, "-x", "160", "-y", "50", "-c", proj,
  `env HOME=${home} agy --dangerously-skip-permissions -i '${prompt}'`);
const log: string[] = [];
const note = (m: string) => log.push(`${t()} ${m}`);
const lastPane = () => tmux("capture-pane", "-p", "-t", session, "-S", "-200").stdout ?? "";

try {
  const routeFile = join(proj, "route.env");
  for (let i = 0; i < 120 && !existsSync(routeFile); i++) {
    // The trust and permission dialogs, if any, take Enter.
    if (/trust|Do you|\(y\/n\)|Yes/i.test(lastPane().split("\n").slice(-12).join("\n"))) tmux("send-keys", "-t", session, "Enter");
    await sleep(1000);
  }
  if (!existsSync(routeFile)) throw new Error(`no route.env\n${lastPane()}`);
  await sleep(500);
  const env = Object.fromEntries(
    readFileSync(routeFile, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]),
  );
  const route = { address: env.ANTIGRAVITY_LS_ADDRESS as string, token: env.ANTIGRAVITY_CSRF_TOKEN as string };
  const id = env.ANTIGRAVITY_CONVERSATION_ID as string;
  note(`route ${route.address}, conversation ${id}`);
  // Command 1 sleeps 15 s after writing route.env; send while command 2 runs.
  await sleep(17_000);
  const meta = await lsCall<{ generatorMetadata?: { chatModel?: { model?: string } }[] }>(
    route, "GetCascadeTrajectoryGeneratorMetadata", { cascadeId: id });
  const model = meta.generatorMetadata?.findLast((m) => m.chatModel?.model)?.chatModel?.model;
  note(`model ${model}; log now: ${existsSync(join(proj, "log")) ? readFileSync(join(proj, "log"), "utf8").trim().replace(/\n/g, " | ") : "(none)"}`);
  const sentAt = Date.now() / 1000;
  const res = await lsCall(route, "SendUserCascadeMessage", {
    cascadeId: id,
    items: [{ text: "Also, as soon as you read this, run the shell command `date +%s.%N > ack.txt` before anything else, then carry on." }],
    deliveryStrategy: `MESSAGE_DELIVERY_STRATEGY_${strategy}`,
    cascadeConfig: { plannerConfig: { planModel: model } },
  });
  note(`sent ${strategy} at ${sentAt.toFixed(1)}: ${JSON.stringify(res)}`);
  // Wait for the turn to end: the four commands, then the ack if it comes after.
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const l = existsSync(join(proj, "log")) ? readFileSync(join(proj, "log"), "utf8") : "";
    if (/c4 /.test(l) && existsSync(join(proj, "ack.txt"))) break;
    if (/c4 /.test(l) && i > 0 && /finished/.test(lastPane())) {
      await sleep(40_000);
      break;
    }
  }
  const read = (f: string) => (existsSync(join(proj, f)) ? readFileSync(join(proj, f), "utf8").trim() : "(none)");
  note(`log:\n${read("log")}`);
  note(`ack: ${read("ack.txt")} (sent ${sentAt.toFixed(1)})`);
  writeFileSync(join(dir, "pane.txt"), lastPane());
} finally {
  tmux("kill-session", "-t", session);
  console.log(log.join("\n"));
  console.log(`pane: ${join(dir, "pane.txt")}`);
  if (!existsSync(join(dir, "pane.txt"))) rmSync(dir, { recursive: true, force: true });
}
