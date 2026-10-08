/**
 * The phone take with a person at the phone: the real CLI on "workstation" asks the eval
 * question (agents.ts) on any server, the owner answers it from the lock screen, and the eval
 * reports its progress. scrcpy records the phone when it is on PATH. Writes <take>/events.json
 * (and phone.mp4), which compose.ts turns into the video, as for scenario.ts.
 *
 *   bun demo/video/cue.ts pair <dir> --server <url>  once per account: pairs "workstation";
 *                                                    approve its code under Devices
 *   bun demo/video/cue.ts take <dir> <take>          on Enter: records, asks, waits, runs
 *   bun demo/video/cue.ts take <dir> <take> --dry-run <stack dir>
 *        no Enter, no recording; a local stack's browser (stack.ts, inbox.ts --sign-in)
 *        answers. <dir> may be the stack's own, whose "workstation" is already paired.
 *
 * <dir> holds the machine's home, so the owner's own pairing and agent are never used.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Agent, EVAL } from "./agents";
import { image } from "./compose";
import { context, press, WEB } from "./inbox";
import { cli } from "./stack";

const [command, dirArg, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i < 0 ? undefined : (rest[i + 1] ?? "");
};
const dir = resolve(dirArg ?? "");

/** Pairs "workstation" in <dir>; the owner approves the printed code in the app or web page. */
async function pair(server: string) {
  mkdirSync(join(dir, "workstation", "run"), { recursive: true });
  const name = "workstation";
  const p = cli(dir, "workstation", ["pair", "--server", server, "--name", name]);
  for await (const chunk of p.stdout) process.stdout.write(chunk);
  if ((await p.exited) !== 0) throw new Error("pairing failed");
  await cli(dir, "workstation", ["config", "machine-kind", "desktop"]).exited;
}

/** scrcpy recording the phone, once its file has data; undefined without scrcpy. */
async function record(path: string): Promise<Bun.Subprocess | undefined> {
  if (!Bun.which("scrcpy")) return undefined;
  rmSync(path, { force: true });
  // scrcpy's log is buffered when piped, so it shows in the terminal and the file is the signal.
  const p = Bun.spawn(["scrcpy", "--no-audio", "--no-control", `--record=${path}`], {
    stdout: "inherit",
    stderr: "inherit",
  });
  for (let i = 0; i < 300; i++) {
    if (p.exitCode !== null) throw new Error(`scrcpy exited with ${p.exitCode} before recording`);
    if (existsSync(path) && statSync(path).size > 0) return p;
    await Bun.sleep(100);
  }
  p.kill("SIGINT");
  throw new Error(`scrcpy wrote nothing to ${path} in 30 s`);
}

/** Answers the eval question from the stack's signed-in browser, as the owner would. */
async function answerInBrowser(agent: Agent, stack: string) {
  const ctx = await context(stack);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(WEB);
    await page.getByText(EVAL.question.question).waitFor({ timeout: 30_000 });
    await press(page, EVAL.answer);
    await agent.wait(15);
  } finally {
    await ctx.close();
  }
}

async function take(out: string, stack?: string) {
  const dry = stack !== undefined;
  mkdirSync(out, { recursive: true });
  if (!existsSync(join(out, "question.png"))) await image(out);
  if (!dry) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(
      "Phone on its lock screen, no other Starbridge notification. Enter starts the take. ",
    );
    rl.close();
  }
  const recording = dry ? undefined : await record(join(out, "phone.mp4"));
  const t0 = performance.now();
  const clock = () => (performance.now() - t0) / 1000;
  const agent = new Agent(EVAL, dir, clock);
  const events: Record<string, number> = {};
  const mark = (name: string) => {
    events[name] = clock();
    console.log(`${clock().toFixed(2)} ${name}`);
  };
  const stop = async () => {
    await agent.stop();
    recording?.kill("SIGINT");
    await recording?.exited;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)));
  try {
    await Bun.sleep(3000);
    await agent.ask(join(out, "question.png"));
    mark("asked");
    console.log(`Tap "${EVAL.answer}" on the lock screen.`);
    await (stack ? answerInBrowser(agent, stack) : agent.wait(120));
    mark("tapped");
    console.log(`Answered: ${agent.answer}. The eval runs for a minute.`);
    await Bun.sleep(1500);
    await agent.run();
    await Bun.sleep(4000);
    mark("end");
  } finally {
    await stop();
  }
  // Without adb the notification's arrival isn't seen: it shows about 1.5 s after the ask.
  const notified = (events.asked ?? 0) + 1.5;
  const e: Record<string, number | undefined> = { ...events, notified, running: agent.running };
  const data = {
    layout: "phone",
    end: events.end,
    poster: notified + 4,
    captions: [
      [0, e.notified, "Your agent needs a decision. You're away from your desk."],
      [e.notified, e.tapped, "It asks on your phone."],
      [e.tapped, e.running, "One tap. The answer goes back into the session."],
      [e.running, e.end, "Runs show their progress there too (sped up 6×)."],
    ],
    fast: [{ from: (agent.running ?? 0) + 1, to: (agent.ran ?? 0) - 0.5, rate: 6 }],
    panes: [agent],
  };
  writeFileSync(join(out, "events.json"), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`take in ${out}${recording ? "" : " (no recording: add phone.mp4)"}`);
}

if (command === "pair" && dirArg && flag("--server")) await pair(flag("--server") as string);
else if (command === "take" && dirArg && rest[0])
  await take(
    resolve(rest[0]),
    flag("--dry-run") ? resolve(flag("--dry-run") as string) : undefined,
  );
else
  throw new Error(
    "usage: cue.ts pair <dir> --server <url> | take <dir> <take> [--dry-run <stack dir>] (see the file's header)",
  );
