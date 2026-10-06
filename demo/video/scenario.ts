/**
 * One take of the demo: records the phone (an emulator or a phone over adb) while the real CLI
 * on "workstation" asks a question with an image, the phone answers it with one tap, and a run
 * reports its progress. Writes <out>/phone.mp4 and <out>/events.json, which compose.ts turns
 * into the video.
 *
 *   bun demo/video/scenario.ts <stack dir> <out dir>
 *
 * The phone must be signed in to the stack's account (README.md), on its lock screen.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cli } from "./stack";

/** A call only the owner can make: where the legacy plans go is a pricing decision. */
export const QUESTION = {
  project: "billing-api",
  session: "Retire legacy tiers",
  question: "Move the 1,284 legacy-tier plans to which plan?",
  context:
    "Legacy tiers end Nov 1. Standard costs the same; Pro costs $4 more after 3 free months.",
  options: ["Standard", "Pro, 3 months free", "Keep legacy"],
  answer: "Standard",
};

export const RUN = {
  title: "Tests, billing-api",
  reason: "after mapping legacy tiers to Standard",
  steps: ["unit: 214 passed", "plans: 38 passed", "invoices: 61 passed", "webhooks: 22 passed"],
};

const adbPath = process.env.ADB ?? "adb";

async function adb(...args: string[]): Promise<string> {
  const p = Bun.spawn([adbPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

/**
 * Where to tap on the lock screen: the notification's expand arrow, then the answer's button.
 * Measured on a 1080×2400 emulator at density 420 with one notification and question.png; set
 * TAP_EXPAND and TAP_ANSWER ("x,y") for another phone. uiautomator can't find them: the
 * notification's ticking timer keeps the screen from going idle, so its dumps time out.
 */
const point = (env: string | undefined, fallback: [number, number]): [number, number] =>
  (env?.split(",").map(Number) as [number, number] | undefined) ?? fallback;
const EXPAND = point(process.env.TAP_EXPAND, [962, 625]);
const ANSWER = point(process.env.TAP_ANSWER, [158, 1308]);

/** Waits until the phone posts a notification with `text`; returns when it saw it. */
async function notification(text: string, seconds = 30): Promise<number> {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await Bun.sleep(200)) {
    const seen = performance.now();
    if ((await adb("shell", "dumpsys", "notification", "--noredact")).includes(text)) return seen;
  }
  throw new Error(`no notification "${text}" on the phone`);
}

const tap = ([x, y]: [number, number]) => adb("shell", "input", "tap", String(x), String(y));
const key = (k: string) => adb("shell", "input", "keyevent", k);

/** Clears notifications left by earlier takes, such as a finished run, with "Clear all". */
async function clearNotifications() {
  await key("KEYCODE_WAKEUP");
  await adb("shell", "cmd", "statusbar", "expand-notifications");
  await Bun.sleep(1500);
  const xml = await adb("exec-out", "uiautomator", "dump", "/dev/tty");
  const b = /text="Clear all"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
  if (b) await tap([(Number(b[1]) + Number(b[3])) / 2, (Number(b[2]) + Number(b[4])) / 2]);
  await adb("shell", "cmd", "statusbar", "collapse");
}

const text = async (p: Bun.Subprocess<"ignore", "pipe", "inherit">) => {
  const out = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0) throw new Error(`the CLI failed:\n${out}`);
  return out;
};

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "demo-video");
  const out = resolve(process.argv[3] ?? join(dir, "take"));
  mkdirSync(out, { recursive: true });
  const project = join(dir, "workstation", QUESTION.project);
  mkdirSync(project, { recursive: true });

  const events: Record<string, number> = {};
  let t0 = 0;
  const mark = (name: string, at = performance.now()) => {
    events[name] = (at - t0) / 1000;
    console.log(`${events[name]?.toFixed(2)} ${name}`);
  };

  await clearNotifications();
  // The lock screen, freshly lit.
  await key("KEYCODE_SLEEP");
  await Bun.sleep(1000);
  await key("KEYCODE_WAKEUP");
  await Bun.sleep(1500);
  await adb("shell", "rm", "-f", "/sdcard/demo.mp4");
  const record = Bun.spawn([
    adbPath,
    "shell",
    "screenrecord",
    "--time-limit",
    "180",
    "/sdcard/demo.mp4",
  ]);
  t0 = performance.now();

  // A failed take stops the recording and the CLI, and withdraws its question.
  const children: Bun.Subprocess[] = [];
  let id = "";
  let answer = "";
  const lines: { t: number; text: string }[] = [];
  try {
    await Bun.sleep(3000);
    mark("ask");
    // `ask --wait` in two steps, so a failed take knows which question to withdraw.
    id = await text(
      cli(
        dir,
        "workstation",
        [
          ...["ask", "--question", QUESTION.question, "--context", QUESTION.context],
          ...QUESTION.options.flatMap((o) => ["--option", o]),
          ...["--image", join(out, "question.png"), "--waiting", "--agent", "claude-code"],
          ...["--project", QUESTION.project, "--session", "demo-retire-legacy-tiers"],
          ...["--session-title", QUESTION.session],
        ],
        project,
      ),
    ).then((o) => o.split("\n")[0] ?? "");
    const wait = cli(dir, "workstation", ["wait", id], project);
    children.push(wait);

    // On the lock screen: the notification arrives, its arrow expands it, one tap answers.
    mark("notified", await notification(QUESTION.question));
    await Bun.sleep(2500);
    await tap(EXPAND);
    mark("expanded");
    await Bun.sleep(3000);
    await tap(ANSWER);
    mark("tapped");
    answer = await text(wait);
    mark("answered");

    await Bun.sleep(1500);
    mark("run");
    const script = RUN.steps
      .map((s, i) => `sleep 1.6; echo "[${i + 1}/${RUN.steps.length}] ${s}"`)
      .join("; ");
    const run = cli(
      dir,
      "workstation",
      ["run", "--title", RUN.title, "--reason", RUN.reason, "--", "sh", "-c", script],
      project,
    );
    children.push(run);
    // Each line with the time it printed, so the terminal shows it then.
    let pending = "";
    for await (const chunk of run.stdout) {
      pending += new TextDecoder().decode(chunk);
      for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
        lines.push({ t: (performance.now() - t0) / 1000, text: pending.slice(0, i) });
        pending = pending.slice(i + 1);
      }
    }
    if ((await run.exited) !== 0) throw new Error("run failed");
    mark("ran");
    await Bun.sleep(4000);
    mark("end");
  } finally {
    for (const child of children) child.kill();
    if (id && !answer)
      await cli(dir, "workstation", ["settle", id, "--outcome", "withdrawn"]).exited;
    await adb("shell", "pkill", "-INT", "screenrecord");
    await record.exited;
  }
  await Bun.sleep(1000);
  await adb("pull", "/sdcard/demo.mp4", join(out, "phone.mp4"));
  writeFileSync(
    join(out, "events.json"),
    `${JSON.stringify({ events, answer, lines, question: QUESTION, run: RUN }, null, 2)}\n`,
  );
  console.log(`take in ${out}`);
}
