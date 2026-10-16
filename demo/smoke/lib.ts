/**
 * What the Android smoke tests share (#1004, #1621): driving an emulator through adb and
 * uiautomator, the app's sign-in and join screens, and a demo machine paired through the demo
 * device. `android.ts` runs them against a local demo server, `staging-android.ts` against
 * staging.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoDevice } from "../src/device";
import { cli } from "../video/stack";

export const PKG = "dev.starbridge.app";

/** The steps run so far, in order: the evidence's list of what was driven. */
export const steps: string[] = [];

export const step = (what: string) => {
  steps.push(what);
  console.log(`[smoke] ${what}`);
};

export class Crash extends Error {
  constructor(readonly log: string) {
    super(`the app crashed, or failed to show a push:\n${log}`);
  }
}

export interface Node {
  text: string;
  desc: string;
  x: number;
  y: number;
}

export async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined>) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    // A probe may fail while things start; a crash ends the wait at once.
    const got = await probe().catch((e) => {
      if (e instanceof Crash) throw e;
      return undefined;
    });
    if (got !== undefined && got !== false) return got;
    if (Date.now() > end) throw new Error(`timed out after ${seconds} s: ${what}`);
    await Bun.sleep(1000);
  }
}

/**
 * Runs `fn` again after a failure, up to `tries` times. Staging restarts its one server on each
 * deploy (60 to 120 a day), which fails a request for a few seconds; a check that long must not
 * fail on that.
 */
export async function retry<T>(what: string, fn: () => Promise<T>, tries = 4, seconds = 10) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries) throw e;
      step(`${what} failed (${(e as Error).message.split("\n")[0]}); retrying in ${seconds} s`);
      await Bun.sleep(seconds * 1000);
    }
  }
}

/** The emulator `adb` reaches (ANDROID_SERIAL picks one), and what `out` collects from it. */
export function emulator(adbPath: string, out: string) {
  async function adb(...args: string[]): Promise<string> {
    const p = Bun.spawn([adbPath, ...args], { stdout: "pipe", stderr: "pipe" });
    const [text, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`adb ${args.join(" ")}: ${code} ${err.trim()}`);
    return text;
  }
  const shell = (command: string) => adb("shell", command);

  /**
   * The app crashed (the crash buffer names it), or it caught and logged an exception: a push that
   * fails to show is caught in FcmService, which is how v0.1.3's regex failed there.
   */
  async function crashed(): Promise<string | undefined> {
    const crash = await adb("logcat", "-b", "crash", "-d");
    if (crash.includes(PKG)) return crash;
    const caught = await adb("logcat", "-d", "-s", "Starbridge:W");
    return caught.includes("push failed") ? caught : undefined;
  }

  async function booted(what: string, seconds: number) {
    await adb("wait-for-device");
    await until(
      what,
      seconds,
      async () => (await shell("getprop sys.boot_completed")).trim() === "1" || undefined,
    );
  }

  async function screen(): Promise<Node[]> {
    const xml = await adb("exec-out", "uiautomator", "dump", "/dev/tty");
    const attr = (n: string, name: string) =>
      (new RegExp(` ${name}="([^"]*)"`).exec(n)?.[1] ?? "")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
    return [...xml.matchAll(/<node [^>]*>/g)].map(([n]) => {
      const [x1, y1, x2, y2] = (/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n) ?? [])
        .slice(1)
        .map(Number) as [number, number, number, number];
      return {
        text: attr(n, "text"),
        desc: attr(n, "content-desc"),
        x: (x1 + x2) >> 1,
        y: (y1 + y2) >> 1,
      };
    });
  }

  const find = (nodes: Node[], label: string) =>
    nodes.find((n) => n.text.includes(label) || n.desc.includes(label));

  /**
   * Waits for the label on screen, failing at once if the app crashed meanwhile. A slow emulator's
   * own apps can stop answering ("Pixel Launcher isn't responding"): that dialog gets Wait.
   */
  async function see(label: string, seconds = 30): Promise<Node> {
    return until(`"${label}" on screen`, seconds, async () => {
      const why = await crashed();
      if (why) throw new Crash(why);
      const nodes = await screen();
      const stuck = nodes.some((n) => n.text.endsWith("isn't responding"));
      const wait = stuck ? find(nodes, "Wait") : undefined;
      if (wait && !label.includes("Wait")) {
        step("an emulator app isn't responding; tapping Wait");
        await shell(`input tap ${wait.x} ${wait.y}`);
        return undefined;
      }
      return find(nodes, label);
    });
  }

  async function tap(label: string, seconds = 30) {
    const n = await see(label, seconds);
    await shell(`input tap ${n.x} ${n.y}`);
  }

  async function type(text: string) {
    // `input text` takes no spaces; %s stands for one.
    await shell(`input text '${text.replaceAll(" ", "%s")}'`);
  }

  /** Clears the field and types the text. */
  async function replace(field: string, text: string) {
    await tap(field);
    await shell("input keyevent KEYCODE_MOVE_END");
    await shell(`input keyevent ${Array(60).fill("KEYCODE_DEL").join(" ")}`);
    await type(text);
  }

  async function evidence(name: string) {
    await Bun.spawn([adbPath, "exec-out", "screencap", "-p"], {
      stdout: Bun.file(join(out, `${name}.png`)),
    }).exited;
    await adb("exec-out", "uiautomator", "dump", "/dev/tty")
      .then((xml) => writeFileSync(join(out, `${name}.xml`), xml))
      .catch(() => {});
  }

  /** The app's first launch through "They match": signed in with an owner token, and joined. */
  async function signInAndJoin(server: string, ownerToken: string) {
    await shell(`am start -W -n ${PKG}/.MainActivity`);
    await tap("Use your own server");
    await replace("Server", server);
    // A slow emulator's keyboard can drop keys; the token field hides what it got.
    for (let attempt = 1; ; attempt++) {
      await replace("Owner token", ownerToken);
      await shell("input keyevent KEYCODE_BACK");
      await tap("Sign in");
      const joining = await see("Compare digits", 30).then(
        () => true,
        (e) => {
          if (e instanceof Crash || attempt === 3) throw e;
          return false;
        },
      );
      if (joining) break;
      step(`sign-in attempt ${attempt} failed; typing the token again`);
    }
    step("join by digits");
    await tap("Compare digits");
    await tap("They match", 60);
    await see("Inbox", 60);
  }

  return {
    adb,
    shell,
    crashed,
    booted,
    screen,
    find,
    see,
    tap,
    type,
    replace,
    evidence,
    signInAndJoin,
  };
}

/** Pairs the demo machine "workstation" through the demo device. */
export async function pair(dir: string, server: string, device: DemoDevice) {
  mkdirSync(join(dir, "workstation", "run"), { recursive: true });
  const p = cli(dir, "workstation", ["pair", "--server", server, "--name", "workstation"]);
  let text = "";
  let approved = false;
  let confirmed = false;
  for await (const chunk of p.stdout) {
    text += new TextDecoder().decode(chunk);
    const code = /Pairing code: (\S+)/.exec(text)?.[1];
    if (code && !approved) {
      approved = true;
      await device.approvePairing(code);
    }
    // As DemoMachine.pair: the owner read the check code.
    if (!confirmed && /Check code: /.test(text)) {
      confirmed = true;
      await cli(dir, "workstation", ["pair", "--confirm"]).exited;
    }
  }
  if ((await p.exited) !== 0) throw new Error(`pair failed:\n${text}`);
}

/** The machine asks a question with context and options; returns its id. */
export function ask(dir: string, question: string, context: string): Promise<string> {
  return retry("ask", () => askOnce(dir, question, context));
}

async function askOnce(dir: string, question: string, context: string): Promise<string> {
  const p = cli(dir, "workstation", [
    "ask",
    "--question",
    question,
    "--context",
    context,
    "--option",
    "Ship tonight",
    "--option",
    "Wait",
    "--project",
    "billing-api",
  ]);
  const id = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0 || !id.startsWith("d_")) throw new Error(`ask failed: ${id}`);
  return id;
}
