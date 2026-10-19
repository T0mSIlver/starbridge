/**
 * The Android run's evidence for a pull request (docs/ci.md, "Evidence"), kept when EVIDENCE names
 * a folder: each stop's screen in light and dark, its UI dump, and beside each screenshot the
 * boxes of the times on it and of the status bar, which web/e2e/evidence.ts leaves out of the
 * comparison with main's.
 * PROFILE (phone, tablet) names the device in every file, since both runs' screens share a comment.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TIME } from "../../web/e2e/volatile";
import type { emulator } from "./lib";

type Emulator = ReturnType<typeof emulator>;

export function keeper(em: Emulator, adbPath: string, dir: string | undefined, profile: string) {
  const shots = dir ? join(dir, "shots") : undefined;
  if (shots) mkdirSync(shots, { recursive: true });
  const time = new RegExp(TIME, "i");
  let noticed = false;
  let logged = false;

  /** The status bar's clock, battery and signal fixed, and its notification icons hidden. */
  async function demoMode() {
    if (!shots) return;
    await em.shell("settings put global sysui_demo_allowed 1");
    if (!logged) {
      logged = true;
      // For the next run to read: two runs of one tree have differed by the status bar's height.
      for (const cmd of [
        "cmd overlay list | grep -i -E 'cutout|navbar|statusbar'",
        "dumpsys display | grep -i -E 'cutout|mBaseDisplayInfo' | head -5",
        "wm size; wm density",
      ])
        console.log(`[evidence] ${cmd}\n${await em.shell(cmd).catch((e) => String(e))}`);
    }
    for (const extras of [
      "-e command enter",
      "-e command clock -e hhmm 1200",
      "-e command battery -e level 100 -e plugged false",
      "-e command network -e wifi show -e level 4 -e mobile hide",
      "-e command notifications -e visible false",
    ])
      await em.shell(`am broadcast -a com.android.systemui.demo ${extras}`);
  }

  /** The screen's pixels, as the emulator draws them now. */
  async function screen(): Promise<Buffer> {
    const p = Bun.spawn([adbPath, "exec-out", "screencap", "-p"], { stdout: "pipe" });
    const png = Buffer.from(await new Response(p.stdout).arrayBuffer());
    await p.exited;
    return png;
  }

  /**
   * Waits for the screen to hold still, then returns it: the snackbar that says Google push is
   * missing (the run's APK has no Firebase) has gone, and two screenshots 700 ms apart are the
   * same, so no inset, fade or scroll is caught half way. Two runs of one tree differed by these.
   */
  async function still(): Promise<Buffer> {
    const snackbar = async () =>
      (await em.adb("exec-out", "uiautomator", "dump", "/dev/tty").catch(() => "")).includes(
        "Google push is not available",
      );
    // It shows some seconds after sign-in and goes by itself; the first shot waits for it to
    // come, the others only for it to go.
    if (!noticed) {
      noticed = true;
      for (let i = 0; i < 15 && !(await snackbar()); i++) await Bun.sleep(1000);
    }
    for (let i = 0; i < 20 && (await snackbar()); i++) await Bun.sleep(1000);
    let last = await screen();
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(700);
      const now = await screen();
      if (now.equals(last)) return now;
      last = now;
    }
    return last;
  }

  async function capture(file: string) {
    // Demo mode ends when the system UI restarts, as it can on a change of night mode.
    await demoMode();
    let xml = "";
    for (let tries = 0; tries < 3; tries++) {
      writeFileSync(`${file}.png`, await still());
      xml = await em.adb("exec-out", "uiautomator", "dump", "/dev/tty").catch(() => "");
      // A snackbar that came while the screen held still: shoot again once it has gone.
      if (!xml.includes("Google push is not available")) break;
    }
    writeFileSync(`${file}.xml`, xml);
    const rects = [...xml.matchAll(/<node [^>]*>/g)].flatMap(([n]) => {
      const text = / text="([^"]*)"/.exec(n)?.[1] ?? "";
      // The launcher's Clock icon shows the time on its face.
      const face = /content-desc="Clock"/.test(n) || text === "Clock";
      if (!time.test(text) && !face) return [];
      const [x1, y1, x2, y2] = (/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n) ?? [])
        .slice(1)
        .map(Number) as [number, number, number, number];
      return [{ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }];
    });
    // A tablet's app drawer is a sheet over the home screen, whose clock widget and date move:
    // only the sheet is compared.
    const sheet = /id\/bottom_sheet_background"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(
      xml,
    );
    if (sheet) {
      const [x1, , x2] = sheet.slice(1).map(Number) as [number, number, number, number];
      rects.push({ x: 0, y: 0, width: x1, height: 100_000 });
      rects.push({ x: x2, y: 0, width: 100_000, height: 100_000 });
    }
    // The status bar: demo mode fixes its clock in the shade but not always above an app, and the
    // shade's header shows the date.
    const density = Number(/(\d+)\s*$/.exec((await em.shell("wm density")).trim())?.[1] ?? 420);
    rects.push({ x: 0, y: 0, width: 100_000, height: Math.ceil((48 * density) / 160) });
    writeFileSync(`${file}.json`, JSON.stringify(rects));
  }

  /** The screen as it is, in light then dark, as `<profile>-<name>-<scheme>.png`. */
  async function keep(
    name: string,
    schemes: ("light" | "dark")[] = ["light", "dark"],
    // Puts the screen back after a change of scheme, which restarts the launcher and closes
    // its drawer on some runs.
    prepare?: () => Promise<void>,
  ) {
    if (!shots) return;
    for (const scheme of schemes) {
      await em.shell(`cmd uimode night ${scheme === "dark" ? "yes" : "no"}`);
      await Bun.sleep(1500);
      await prepare?.();
      await capture(join(shots, `${profile}-${name}-${scheme}`));
    }
    await em.shell("cmd uimode night no");
    await Bun.sleep(1000);
  }

  /**
   * The app drawer, where our icon sits beside the stock apps' at the same size: under the
   * launcher's own shape, then each icon shape the system image offers as an overlay.
   */
  async function launcher() {
    if (!shots) return;
    const drawer = async () => {
      // A swipe now and then opens nothing, which left the home screen in the shot: swipe again
      // until the launcher's app list is on screen, three times at most.
      for (let attempt = 1; attempt <= 3; attempt++) {
        await em.shell("input keyevent KEYCODE_HOME");
        await Bun.sleep(1000);
        const size = /(\d+)x(\d+)/.exec(await em.shell("wm size")) ?? [];
        const [w, h] = [Number(size[1] ?? 1080), Number(size[2] ?? 2400)];
        await em.shell(`input swipe ${w >> 1} ${Math.round(h * 0.85)} ${w >> 1} ${h >> 3} 300`);
        let open = false;
        for (let i = 0; i < 8 && !open; i++) {
          const xml = await em.adb("exec-out", "uiautomator", "dump", "/dev/tty").catch(() => "");
          open = xml.includes("id/apps_list_view");
          if (!open) await Bun.sleep(1000);
        }
        if (open) break;
      }
      await em.see("Starbridge", 15).catch(() => undefined);
      await Bun.sleep(1000);
    };
    await drawer();
    await keep("apps", ["light", "dark"], drawer);
    const shapes = (await em.shell("cmd overlay list"))
      .split("\n")
      .map((l) => /com\.android\.theme\.icon\.(\w+)/.exec(l)?.[1])
      .filter((s): s is string => !!s);
    for (const shape of shapes) {
      await em.shell(`cmd overlay enable-exclusive --category com.android.theme.icon.${shape}`);
      await Bun.sleep(2000);
      await drawer();
      await keep(`apps-${shape}`, ["light"], drawer);
    }
    if (shapes.length)
      for (const line of (await em.shell("cmd overlay list")).split("\n"))
        if (/\[x\] com\.android\.theme\.icon\./.test(line))
          await em.shell(`cmd overlay disable ${line.replace(/^.*\] /, "").trim()}`);
  }

  function manifest(steps: string[], error?: unknown) {
    if (!dir) return;
    writeFileSync(
      join(dir, "manifest.json"),
      `${JSON.stringify(
        {
          shard: profile,
          passed: error === undefined,
          error: error === undefined ? undefined : String(error).slice(0, 2000),
          steps,
        },
        null,
        2,
      )}\n`,
    );
  }

  return { demoMode, keep, launcher, manifest };
}
