/**
 * The phone take: records an Android phone (or emulator) over adb while the real CLI on
 * "workstation" asks a question with an image, the phone answers it from the lock screen with one
 * tap, and a run reports its progress. Writes <out>/phone.mp4 and <out>/events.json, which
 * compose.ts turns into the video.
 *
 *   bun demo/video/scenario.ts <stack dir> <out dir>
 *
 * The phone must be signed in to the stack's account (README.md), on its lock screen.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent, EVAL } from "./agents";
import { image } from "./compose";

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
const ANSWER = point(process.env.TAP_ANSWER, [182, 1308]);

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
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = await adb("shell", "dumpsys", "notification", "--noredact");
    if (!left.includes(": pkg=dev.starbridge.app")) return;
    // The shade opens only once the lock screen (no PIN) is gone.
    await adb("shell", "wm", "dismiss-keyguard");
    await Bun.sleep(1000);
    await adb("shell", "cmd", "statusbar", "expand-notifications");
    await Bun.sleep(2000);
    const xml = await adb("exec-out", "uiautomator", "dump", "/dev/tty");
    const b = /text="Clear all"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
    if (b) await tap([(Number(b[1]) + Number(b[3])) / 2, (Number(b[2]) + Number(b[4])) / 2]);
    await Bun.sleep(1000);
    await adb("shell", "cmd", "statusbar", "collapse");
  }
  throw new Error("the phone still shows Starbridge notifications: withdraw open questions first");
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "demo-video");
  const out = resolve(process.argv[3] ?? join(dir, "take"));
  mkdirSync(out, { recursive: true });
  if (!existsSync(join(out, "question.png"))) await image(out);
  let t0 = 0;
  const clock = () => (performance.now() - t0) / 1000;
  const agent = new Agent(EVAL, dir, clock);
  const events: Record<string, number> = {};
  const mark = (name: string, at = clock()) => {
    events[name] = at;
    console.log(`${at.toFixed(2)} ${name}`);
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

  // A failed or interrupted take stops the recording and the CLI, and withdraws its question.
  const stop = async () => {
    await agent.stop();
    await adb("shell", "pkill", "-INT", "screenrecord");
    await record.exited;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)));
  try {
    const { question } = EVAL.question;
    // A notification left by an earlier take would be found at once, and the taps land early.
    if ((await adb("shell", "dumpsys", "notification", "--noredact")).includes(question))
      throw new Error("the phone still shows this question from an earlier take: withdraw it");
    await Bun.sleep(3000);
    await agent.ask(join(out, "question.png"));
    const answered = agent.wait(60);
    answered.catch(() => {});

    // On the lock screen: the notification arrives, its arrow expands it, one tap answers.
    const seen = await notification(question);
    mark("notified", (seen - t0) / 1000);
    await Bun.sleep(2500);
    await tap(EXPAND);
    await Bun.sleep(3000);
    await tap(ANSWER);
    mark("tapped");
    await Promise.race([
      answered,
      Bun.sleep(8000).then(() => {
        throw new Error("no answer 8 s after the tap: it missed (see TAP_ANSWER), take again");
      }),
    ]);
    await Bun.sleep(1500);
    await agent.run();
    await Bun.sleep(4000);
    mark("end");
  } finally {
    await stop();
  }
  await Bun.sleep(1000);
  await adb("pull", "/sdcard/demo.mp4", join(out, "phone.mp4"));
  const e: Record<string, number | undefined> = { ...events, running: agent.running };
  const take = {
    layout: "phone",
    end: events.end,
    poster: (events.notified ?? 0) + 4,
    captions: [
      [0, e.notified, "Your agent needs a decision. You're away from your desk."],
      [e.notified, e.tapped, "It asks on your phone."],
      [e.tapped, e.running, "One tap. The answer goes back into the session."],
      [e.running, e.end, "Runs show their progress there too (sped up 6×)."],
    ],
    // The run takes a minute; its middle plays at 6×.
    fast: [{ from: (agent.running ?? 0) + 1, to: (agent.ran ?? 0) - 0.5, rate: 6 }],
    panes: [agent],
  };
  writeFileSync(join(out, "events.json"), `${JSON.stringify(take, null, 2)}\n`);
  console.log(`take in ${out}`);
}
