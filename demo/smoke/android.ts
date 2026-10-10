/**
 * The release smoke (#1004): the release APK on a real Android runtime gets a question with
 * context through an FCM message, shows its notification, and opens its card without a crash.
 * JVM tests can't catch what only Android's runtime refuses, such as ICU's regex syntax (v0.1.3).
 *
 *   bun demo/smoke/android.ts <apk> [out dir]
 *
 * It walks the Play reviewer's path against a demo server on 127.0.0.1, reached through
 * `adb reverse`: sign in with the owner token, join by digits. The server's FCM requests go to a
 * fake FCM here, and the payload is delivered as Play services delivers it, which needs a root
 * shell: a `google_apis` image, not `google_apis_playstore`. Env: ADB (adb), ANDROID_SERIAL, PORT
 * (8411). Exits 1 on failure, leaving screenshots, the UI dump and logcat in the out dir.
 */

import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DemoDevice } from "../src/device";
import { cli, ROOT } from "../video/stack";

const PKG = "dev.starbridge.app";
const QUESTION = "Ship the invoice migration tonight, or wait for the backfill?";
/** Every block the context subset renders: bold, code, a heading, both lists and both links. */
const CONTEXT = [
  "The **NOT NULL** column needs a value for `invoices` written before today.",
  "",
  "## Options",
  "- Backfill now: about 4 minutes, and it locks the table",
  "- Default of 0: ships now",
  "",
  "1. Merge the migration",
  "2. Run the backfill tonight",
  "",
  "Runbook: [backfills](https://starbridge.run/docs) and https://github.com/T0mSIlver/starbridge",
].join("\n");
/** Text the card shows only once it rendered the context. */
const RENDERED = "Run the backfill tonight";

const [apkArg, outArg] = process.argv.slice(2);
if (!apkArg) {
  console.error("usage: bun demo/smoke/android.ts <apk> [out dir]");
  process.exit(64);
}
const apk = resolve(apkArg);
const out = resolve(outArg ?? "smoke-out");
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "starbridge-smoke-"));
const port = Number(process.env.PORT ?? 8411);
const server = `http://127.0.0.1:${port}`;
// Letters and digits only: `input text` is typed through the keyboard.
const ownerToken = crypto.randomUUID().replaceAll("-", "");
const ADB = process.env.ADB ?? "adb";

const step = (what: string) => console.log(`[smoke] ${what}`);

async function adb(...args: string[]): Promise<string> {
  const p = Bun.spawn([ADB, ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`adb ${args.join(" ")}: ${code} ${err.trim()}`);
  return text;
}
const shell = (command: string) => adb("shell", command);

class Crash extends Error {
  constructor(readonly log: string) {
    super(`the app crashed, or failed to show a push:\n${log}`);
  }
}

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined>) {
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

interface Node {
  text: string;
  desc: string;
  x: number;
  y: number;
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

/** Waits for the label on screen, failing at once if the app crashed meanwhile. */
async function see(label: string, seconds = 30): Promise<Node> {
  return until(`"${label}" on screen`, seconds, async () => {
    const why = await crashed();
    if (why) throw new Crash(why);
    return find(await screen(), label);
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

/** A fake FCM: an OAuth token endpoint and messages:send, which records each message. */
function fakeFcm() {
  const messages: { token: string; p: string }[] = [];
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token")
        return Response.json({ access_token: "fake", expires_in: 3600 });
      if (url.pathname.endsWith("/messages:send")) {
        const { message } = (await req.json()) as {
          message: { token: string; data: { p: string } };
        };
        messages.push({ token: message.token, p: message.data.p });
        return Response.json({ name: `projects/smoke/messages/${messages.length}` });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${http.port}`, messages, stop: () => http.stop(true) };
}

async function startServer(fcm: string) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sbd = Bun.spawn(["bun", join(ROOT, "server/src/main.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(dir, "starbridge.db"),
      PUBLIC_URL: server,
      OWNER_TOKEN: ownerToken,
      DEMO: "1",
      FCM_PROJECT_ID: "smoke",
      FCM_CLIENT_EMAIL: "smoke@smoke.invalid",
      FCM_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      FCM_TOKEN_URL: `${fcm}/token`,
      FCM_API_URL: fcm,
    },
    stdout: Bun.file(join(out, "server.log")),
    stderr: Bun.file(join(out, "server.err")),
  });
  await until("the server's /healthz", 30, () =>
    fetch(`${server}/healthz`).then((r) => r.ok || undefined),
  );
  return sbd;
}

/** Pairs the demo machine "workstation" through the demo device. */
async function pair(device: DemoDevice) {
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

async function ask(): Promise<string> {
  const p = cli(dir, "workstation", [
    "ask",
    "--question",
    QUESTION,
    "--context",
    CONTEXT,
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

async function evidence(name: string) {
  await Bun.spawn([ADB, "exec-out", "screencap", "-p"], {
    stdout: Bun.file(join(out, `${name}.png`)),
  }).exited;
  await adb("exec-out", "uiautomator", "dump", "/dev/tty")
    .then((xml) => writeFileSync(join(out, `${name}.xml`), xml))
    .catch(() => {});
}

const fcm = fakeFcm();
const sbd = await startServer(fcm.url);
const stop = new AbortController();
let failed = false;
try {
  step("demo account and machine");
  const device = new DemoDevice(server, ownerToken, (line) => step(line));
  await device.createAccount();
  await pair(device);
  void device.approveJoins(stop.signal).catch((e) => {
    if (!stop.signal.aborted) step(`approving joins stopped: ${e.message}`);
  });

  step("emulator");
  await booted("boot", 300);
  // The FCM broadcast is guarded by a permission only Play services holds; root holds every one.
  // adbd restarts as root, and the emulator can drop offline meanwhile (#1029): wait, then retry once.
  for (let attempt = 1; ; attempt++) {
    const error = await adb("root").then(
      () => undefined,
      (e: Error) => e,
    );
    await booted("boot after adb root", 120);
    if ((await shell("id -u")).trim() === "0") break;
    if (attempt === 2) throw error ?? new Error("adb root left the shell unprivileged");
    step(`adb root, attempt ${attempt} failed: ${error?.message ?? "shell not root"}; retrying`);
  }
  await adb("reverse", `tcp:${port}`, `tcp:${port}`);
  await shell("input keyevent KEYCODE_WAKEUP");
  await shell("wm dismiss-keyguard");
  await adb("uninstall", PKG).catch(() => {});
  step(`install ${apk}`);
  await adb("install", "-r", "-g", apk);
  await adb("logcat", "-b", "all", "-c");

  step("sign in with the owner token");
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
  // Play services hands out a token only once Google's servers answered it, which a fresh
  // emulator may take minutes to do. This one goes through the same onNewToken; a real token
  // that comes later replaces it, and the server sends to the fake FCM either way.
  await shell(
    `am startservice -n ${PKG}/.push.FcmService -a com.google.firebase.messaging.NEW_TOKEN --es token smoke-token`,
  );

  await until("the app's push subscription", 60, async () => {
    const db = new Database(join(dir, "starbridge.db"), { readonly: true });
    try {
      return db.query("SELECT 1 FROM push_subscriptions WHERE type = 'fcm'").get() ?? undefined;
    } finally {
      db.close();
    }
  });

  step("app in the background; the machine asks");
  await shell("input keyevent KEYCODE_HOME");
  const sent = fcm.messages.length;
  const id = await ask();
  const message = await until("the server's FCM message for the question", 60, async () =>
    fcm.messages.slice(sent).find((m) => m.p.includes(id)),
  );

  step("deliver the FCM message");
  writeFileSync(join(dir, "p.json"), message.p);
  await adb("push", join(dir, "p.json"), "/data/local/tmp/p.json");
  await shell(
    `am broadcast -a com.google.android.c2dm.intent.RECEIVE -n ${PKG}/com.google.firebase.iid.FirebaseInstanceIdReceiver --es p "$(cat /data/local/tmp/p.json)" --es google.message_id smoke-${id} --es from smoke`,
  );
  await until("the question's notification", 30, async () => {
    const why = await crashed();
    if (why) throw new Crash(why);
    return (await shell("dumpsys notification --noredact")).includes(QUESTION) || undefined;
  });

  step("open the notification");
  await shell("cmd statusbar expand-notifications");
  await tap(QUESTION.slice(0, 30));
  await see(RENDERED);
  await Bun.sleep(2000);
  const why = await crashed();
  if (why) throw new Crash(why);
  await evidence("card");
  step("passed: notification shown, card opened with its context");
} catch (e) {
  failed = true;
  console.error(`[smoke] FAILED: ${(e as Error).message}`);
  await evidence("failure");
} finally {
  stop.abort();
  await adb("logcat", "-d")
    .then((log) => writeFileSync(join(out, "logcat.txt"), log))
    .catch(() => {});
  sbd.kill();
  fcm.stop();
}
process.exit(failed ? 1 : 0);
