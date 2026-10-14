/**
 * The Android app against staging (#1621): the app built from main signs in to staging, a paired
 * machine asks a question with context, its push comes through staging's relay (starbridge.run)
 * and real FCM to the emulator's Play services, the app opens the card and answers it, and the
 * asking machine reads the answer. Catches a server change the app cannot take before an rc
 * ships it; the sb-check round trip on staging has no app in it.
 *
 *   STAGING_OWNER_TOKEN=... bun demo/smoke/staging-android.ts <apk> [out dir]
 *
 * Staging's owner account is the check's own: it starts from an empty one (a leftover from a
 * failed run is deleted first) and deletes it at the end, so no key outlives a run. The APK needs
 * Firebase's config, or the app has no FCM and no push can reach it. Env: STAGING_URL
 * (https://staging.starbridge.run), ADB, ANDROID_SERIAL. Exits 1 on failure, leaving screenshots,
 * the UI dump and logcat in the out dir.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DemoDevice } from "../src/device";
import { cli } from "../video/stack";
import { ask, Crash, emulator, pair, retry, step, until } from "./lib";
import { clearLeftover } from "./staging-clear";

const CONTEXT = [
  "Posted by the app check on staging (#1621): the **NOT NULL** column needs a value for `invoices`.",
  "",
  "- Backfill now: about 4 minutes",
  "- Default of 0: ships now",
  "",
  "1. Merge the migration",
  "2. Run the backfill tonight",
  "",
  "Runbook: [backfills](https://starbridge.run/docs)",
].join("\n");
/** Text the card shows only once it rendered the context. */
const RENDERED = "Run the backfill tonight";
const CHOICE = "Ship tonight";
/** Questions asked before the push is given up on: a fresh emulator's token can take minutes. */
const ATTEMPTS = 8;
const WAIT_PER_ATTEMPT = 45;

const [apkArg, outArg] = process.argv.slice(2);
const ownerToken = process.env.STAGING_OWNER_TOKEN;
if (!apkArg || !ownerToken) {
  console.error("usage: STAGING_OWNER_TOKEN=... bun demo/smoke/staging-android.ts <apk> [out dir]");
  process.exit(64);
}
const server = (process.env.STAGING_URL ?? "https://staging.starbridge.run").replace(/\/$/, "");
const apk = resolve(apkArg);
const out = resolve(outArg ?? "staging-out");
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "starbridge-staging-check-"));
const ADB = process.env.ADB ?? "adb";
const { adb, shell, booted, see, tap, crashed, evidence, signInAndJoin } = emulator(ADB, out);

const device = new DemoDevice(server, ownerToken, (line) => step(line), false);
let created = false;
const stop = new AbortController();
let failed = false;
try {
  step(`staging account and machine on ${server}`);
  // A deploy restarting staging meanwhile fails a call: start over, from an empty account.
  await retry("account and machine", async () => {
    await clearLeftover(server, ownerToken, step);
    created = true;
    await device.createAccount();
    await pair(dir, server, device);
  });
  void device.approveJoins(stop.signal).catch((e) => {
    if (!stop.signal.aborted) step(`approving joins stopped: ${e.message}`);
  });

  step("emulator");
  await booted("boot", 300);
  await shell("input keyevent KEYCODE_WAKEUP");
  await shell("wm dismiss-keyguard");
  await adb("uninstall", "dev.starbridge.app").catch(() => {});
  step(`install ${apk}`);
  await adb("install", "-r", "-g", apk);
  await adb("logcat", "-b", "all", "-c");

  step("sign in with the owner token");
  await signInAndJoin(server, ownerToken);

  // No token is injected: Play services hands the app its own once Google's servers answered,
  // which a fresh emulator can take minutes to do. Until then staging has nowhere to push, so
  // the machine asks again every WAIT_PER_ATTEMPT seconds until a notification shows.
  step("app in the background; the machine asks until a push arrives");
  await shell("input keyevent KEYCODE_HOME");
  const asked: { id: string; question: string }[] = [];
  const pushed = await (async () => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const question = `[${crypto.randomUUID().slice(0, 4)}] Ship the invoice migration tonight, or wait?`;
      asked.push({ id: await ask(dir, question, CONTEXT), question });
      step(`asked ${asked.at(-1)?.id}, attempt ${attempt}`);
      const hit = await until("a notification for a question", WAIT_PER_ATTEMPT, async () => {
        const why = await crashed();
        if (why) throw new Crash(why);
        const shown = await shell("dumpsys notification --noredact");
        return asked.find((a) => shown.includes(a.question));
      }).catch((e) => {
        if (e instanceof Crash) throw e;
        return undefined;
      });
      if (hit) return hit;
    }
  })();
  if (!pushed)
    throw new Error(
      `no push reached the app in ${ATTEMPTS} questions: staging's relay, FCM or the app's token`,
    );

  step("open the notification");
  await shell("cmd statusbar expand-notifications");
  await tap(pushed.question.slice(0, 30));
  await see(RENDERED);
  await evidence("card");

  step("answer");
  await tap(CHOICE);

  step("the machine reads the answer");
  let text = "";
  let code = 1;
  // Exit 1 is a failed call (a deploy restarting staging); 2 is no answer in time.
  for (let attempt = 1; attempt <= 3 && code === 1; attempt++) {
    const wait = cli(dir, "workstation", ["wait", pushed.id, "--json", "--timeout", "60s"]);
    [text, code] = await Promise.all([new Response(wait.stdout).text(), wait.exited]);
    if (code === 1) await Bun.sleep(10_000);
  }
  const answer = code === 0 ? (JSON.parse(text) as { choice?: string }) : undefined;
  if (answer?.choice !== CHOICE)
    throw new Error(`the machine did not read "${CHOICE}": exit ${code}, ${text.trim()}`);
  const why = await crashed();
  if (why) throw new Crash(why);
  step(
    "passed: signed in, pushed through the relay and FCM, opened, answered, read by the machine",
  );
} catch (e) {
  failed = true;
  console.error(`[smoke] FAILED: ${(e as Error).message}`);
  await evidence("failure");
} finally {
  stop.abort();
  await adb("logcat", "-d")
    .then((log) => writeFileSync(join(out, "logcat.txt"), log))
    .catch(() => {});
  if (created)
    await retry("delete the account", () => device.deleteAccount()).catch((e) => {
      failed = true;
      console.error(`[smoke] the account was not deleted: ${(e as Error).message}`);
    });
}
process.exit(failed ? 1 : 0);
