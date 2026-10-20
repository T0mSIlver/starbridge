// Launches the app on a stand-in server page and checks the bridge end to end: the window loads
// the page, the page's count turns the menu bar's dot amber, a question notifies with its options, a button
// and a typed reply answer through the page, the notification closes once the question leaves,
// the window refuses another origin, a hidden window still notifies, and the Mac's lock and quitting
// reach the page as away, and an update from a stand-in release feed downloads with its progress, then gives way to a tip build. Notifications and the tray are watched in the main
// process, so no OS notification is needed (GitHub's macOS runners cannot grant the permission).
//
//   pnpm --filter @starbridge/desktop e2e     (on Linux: xvfb-run -a …)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const DESKTOP = resolve(import.meta.dirname, "..");
const MAC = process.platform === "darwin";

/** The stand-in page's globals. */
type StandIn = {
  answers: unknown[];
  send(entries: unknown[]): void;
  readings: { away: boolean; idleMs: number | null }[];
  updates: { state: string; percent?: number; version?: string }[];
};

/** What the main process records in place of the OS. */
type Watched = {
  shown: Electron.Notification[];
  closed: string[];
  tips: string[];
  /** Whether each menu bar icon set was the one-colour template. */
  template: boolean[];
  outside: string[];
  destroyed: number;
};

const PAGE = `<!doctype html><title>stand-in</title><script>
window.answers = [];
const b = window.starbridgeDesktop;
document.title = b ? "bridge " + b.version : "no bridge";
if (b) b.onAnswer(async (a) => { window.answers.push(a); if (a.text === "fail") throw new Error("offline"); });
window.send = (entries) => b.update({ count: entries.length, entries });
// Away, as the page's presence would say absent: the server hears it, even as the app quits.
window.readings = [];
if (b) b.onScreen(async () => { const r = b.screen(); window.readings.push(r); if (r.away) await fetch("/away", { method: "POST" }); });
// Downloads wait for the owner's click, which the test makes.
window.updates = [];
if (b) { b.setUpdateSettings({ autoDownload: false }); b.onUpdate(() => { const u = b.updateStatus(); if (u) window.updates.push(u); }); }
</script>`;

/** Requests other than GET, by path. */
const posted: string[] = [];

function serve(body: string): Promise<Server> {
  const s = createServer((req, res) => {
    if (req.method !== "GET") posted.push(req.url ?? "");
    res.setHeader("content-type", "text/html").end(body);
  });
  return new Promise((done) => s.listen(0, "127.0.0.1", () => done(s)));
}
const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

async function until<T>(f: () => Promise<T>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * GitHub's release pages for a 9.9.9 (src/updater.ts), whose file comes in slowly so the
 * download's progress shows. Linux's updater reads latest-linux.yml, macOS's latest-mac.yml.
 */
// Linux's updater installs it on quit and runs it: a script that does nothing.
const UPDATE = Buffer.from(`#!/bin/sh\nexit 0\n#${"-".repeat(2_000_000)}\n`);
const updateFile = MAC ? "Starbridge-9.9.9-mac.zip" : "Starbridge-9.9.9.AppImage";
const updateYml = `version: 9.9.9
files:
  - url: ${updateFile}
    sha512: ${createHash("sha512").update(UPDATE).digest("base64")}
    size: ${UPDATE.length}
path: ${updateFile}
releaseDate: '2026-10-12T00:00:00.000Z'
`;
const releases = createServer(async (req, res) => {
  // The updater adds ?noCache=… to what it reads.
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (path === "/releases/latest")
    return res.writeHead(302, { location: `${url(releases)}/releases/tag/v9.9.9` }).end();
  // The version under test may be an rc, which follows the feed too; it lists none newer.
  if (path === "/releases.atom") return res.end("<feed></feed>");
  // The tip repository's one release (#1692), whose build is newer still.
  if (/^\/tip\/releases\/download\/tip\/latest-(mac|linux)\.yml$/.test(path))
    return res
      .setHeader("content-type", "text/yaml")
      .end(updateYml.replaceAll("9.9.9", "9.9.10-tip.1"));
  if (/^\/releases\/download\/v9\.9\.9\/latest-(mac|linux)\.yml$/.test(path))
    return res.setHeader("content-type", "text/yaml").end(updateYml);
  if (path === `/releases/download/v9.9.9/${updateFile}`) {
    res.writeHead(200, { "content-length": UPDATE.length });
    const step = Math.ceil(UPDATE.length / 10);
    for (let i = 0; i < 10; i++) {
      res.write(UPDATE.subarray(i * step, (i + 1) * step));
      await new Promise((r) => setTimeout(r, 400));
    }
    return res.end();
  }
  res.writeHead(404).end();
});
await new Promise<void>((done) => releases.listen(0, "127.0.0.1", done));
// An unpackaged app's updater reads its download folder's name from this file, which electron-builder
// writes into a packaged one as app-update.yml.
const CACHE = "starbridge-smoke-updater";
writeFileSync(join(DESKTOP, "dev-app-update.yml"), `updaterCacheDirName: ${CACHE}\n`);

const server = await serve(PAGE);
const other = await serve(`<title>other</title>`);
const data = mkdtempSync(join(tmpdir(), "sb-desktop-"));
// Linux's updater replaces the AppImage it runs from, which a development run has none of.
const appImage = join(data, "Starbridge.AppImage");
writeFileSync(appImage, "");
const app = await electron.launch({
  args: [DESKTOP, `--user-data-dir=${data}`],
  env: {
    ...process.env,
    STARBRIDGE_SERVER: url(server),
    STARBRIDGE_RELEASES: url(releases),
    STARBRIDGE_TIP: `${url(releases)}/tip`,
    APPIMAGE: appImage,
  },
});
try {
  await app.evaluate(({ Notification, Tray, shell }) => {
    const g = globalThis as Record<string, unknown>;
    const shown: unknown[] = [];
    const closed: string[] = [];
    const tips: string[] = [];
    const template: boolean[] = [];
    const outside: string[] = [];
    Object.assign(g, { shown, closed, tips, template, outside, destroyed: 0 });
    Notification.prototype.show = function (this: Electron.Notification) {
      shown.push(this);
    };
    Notification.prototype.close = function (this: Electron.Notification) {
      closed.push(this.id);
    };
    Tray.prototype.setToolTip = (t: string) => {
      tips.push(t);
    };
    Tray.prototype.setImage = function (this: Electron.Tray, i: Electron.NativeImage) {
      g.tray = this;
      template.push(i.isTemplateImage());
    };
    Tray.prototype.popUpContextMenu = (m?: Electron.Menu) => {
      g.menu = m;
    };
    Tray.prototype.destroy = () => {
      (g.destroyed as number)++;
    };
    shell.openExternal = async (u: string) => {
      outside.push(u);
    };
  });
  const page = await app.firstWindow();
  await page.waitForLoadState();
  assert.equal(
    await page.title(),
    `bridge ${JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")).version}`,
  );

  const q = {
    id: "d-1",
    title: "Ship it?",
    body: "devbox · starbridge",
    options: ["yes", "no"],
    reply: true,
    waiting: false,
  };
  const p = {
    id: "p-1",
    title: "Run rm -rf build?",
    body: "devbox",
    options: [],
    reply: false,
    waiting: true,
  };
  await page.evaluate(([q, p]) => (window as unknown as StandIn).send([q, p]), [q, p] as const);

  const main = <T>(f: (g: Watched) => T) =>
    app.evaluate(
      (_e, src) => new Function("g", `return (${src})(g)`)(globalThis),
      f.toString(),
    ) as Promise<T>;
  await until(
    () => main((g) => g.tips.at(-1) === "Starbridge: 2 need you" && !g.template.at(-1)),
    "the menu bar's amber dot",
  );
  const shown = await main((g) =>
    g.shown.map((n: Electron.Notification) => ({
      id: n.id,
      title: n.title,
      actions: n.actions.map((a) => a.text),
      reply: n.hasReply,
    })),
  );
  assert.deepEqual(shown, [
    { id: "item-d-1", title: "Ship it?", actions: ["yes", "no"], reply: true },
    { id: "item-p-1", title: "Run rm -rf build?", actions: [], reply: false },
  ]);

  // A button, then a typed reply, answer through the page.
  await main((g) => g.shown[0]?.emit("action", { actionIndex: 1 }, 1));
  await main((g) => g.shown[0]?.emit("reply", { reply: "after lunch" }, "after lunch"));
  const answers = await until(
    () =>
      page.evaluate(() =>
        (window as unknown as StandIn).answers.length === 2
          ? (window as unknown as StandIn).answers
          : null,
      ),
    "two answers",
  );
  assert.deepEqual(answers, [
    { id: "d-1", choice: "no" },
    { id: "d-1", text: "after lunch" },
  ]);
  await until(
    () => main((g) => g.closed.includes("item-d-1")),
    "the answered notification to close",
  );

  // A failed answer says so in a notification of its own.
  await main((g) => g.shown[1]?.emit("reply", { reply: "fail" }, "fail"));
  await until(
    () =>
      main((g) =>
        g.shown.some(
          (n: Electron.Notification) => n.title === "Answer not sent" && n.body === "offline",
        ),
      ),
    "Answer not sent",
  );

  // Answered elsewhere: the page drops it, and its notification closes.
  await page.evaluate(() => (window as unknown as StandIn).send([]));
  await until(
    () =>
      main((g) => g.closed.includes("item-p-1") && g.tips.at(-1) === "Starbridge").then(
        // Template images are a macOS idea; elsewhere every image reads as not one.
        async (ok) => ok && (!MAC || (await main((g) => g.template.at(-1) === true))),
      ),
    "the prompt to close",
  );

  // Hidden, the page keeps its timers at full speed, so a question still notifies at once.
  // Chromium would slow them to once a second, then once a minute; GitHub's runners never do,
  // so the setting is what can be checked here, and the timing on a real Mac.
  const hidden = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.hide();
    return { visible: w?.isVisible(), throttled: w?.webContents.getBackgroundThrottling() };
  });
  assert.deepEqual(hidden, { visible: false, throttled: false });
  const late = { ...q, id: "d-2", title: "Still there?" };
  await page.evaluate((late) => (window as unknown as StandIn).send([late]), late);
  await until(
    () => main((g) => g.shown.some((n) => n.id === "item-d-2")),
    "a hidden window's notification",
  );

  // Refused, as while macOS still asks to allow notifications: the page's next update shows it again.
  await main((g) => g.shown.find((n) => n.id === "item-d-2")?.emit("failed", {}, "not allowed"));
  await page.evaluate((late) => (window as unknown as StandIn).send([late]), late);
  await until(
    () => main((g) => g.shown.filter((n) => n.id === "item-d-2").length === 2),
    "the refused notification again",
  );

  // An update (#1398): found, downloaded on the owner's click with its progress, then ready to
  // restart. On macOS that is once the zip is in: Squirrel, which refuses this one, comes after.
  const statuses = () => page.evaluate(() => (window as unknown as StandIn).updates);
  await until(
    async () => (await statuses()).some((u) => u.state === "available" && u.version === "9.9.9"),
    "the update found",
  );
  await page.evaluate(`window.starbridgeDesktop.updateAction("download")`);
  const last = await until(async () => {
    const u = (await statuses()).at(-1);
    return u && (u.state === "ready" || u.state === "error") ? u : null;
  }, "the download to end");
  const progress = (await statuses()).filter((u) => u.state === "downloading");
  assert.ok(
    progress.some((u) => (u.percent ?? 0) > 0 && (u.percent ?? 0) < 100),
    "progress",
  );
  assert.deepEqual(last, { state: "ready", version: "9.9.9" });
  assert.equal(
    await page.evaluate(`window.starbridgeDesktop.updateSettings().autoDownload`),
    false,
  );
  // Only a tip build can pick Tip, which then reads the tip repository, whose build replaces the
  // downloaded release. This run's version is the package's, never a tip build's.
  const settings = () => page.evaluate(`window.starbridgeDesktop.updateSettings()`);
  await page.evaluate(`window.starbridgeDesktop.setUpdateSettings({ channel: "tip" })`);
  await until(async () => (await settings()) && true, "the settings");
  assert.equal(((await settings()) as { channel: string }).channel !== "tip", true);
  assert.equal(((await settings()) as { tip: boolean }).tip, false);
  // Electron's app.setVersion, which its types leave out, stands in for a tip build.
  await app.evaluate(({ app }) =>
    (app as unknown as { setVersion(v: string): void }).setVersion("9.9.9-tip.0"),
  );
  await page.evaluate(`window.starbridgeDesktop.setUpdateSettings({ channel: "tip" })`);
  await until(
    async () => (await statuses()).at(-1)?.version === "9.9.10-tip.1",
    "the tip build found",
  );
  assert.deepEqual(await page.evaluate(`window.starbridgeDesktop.updateSettings()`), {
    channel: "tip",
    autoDownload: false,
    releaseCandidates: true,
    ahead: false,
    tip: true,
  });

  // The menu bar icon's menu holds what the closed window can't do (#1449); Settings… opens the
  // page's Settings, where the page reads Open at login over the bridge.
  const labels = await app.evaluate(() => {
    const g = globalThis as { tray?: Electron.Tray; menu?: Electron.Menu };
    g.tray?.emit("right-click");
    return g.menu?.items.map((i) => i.label);
  });
  assert.deepEqual(labels, ["Open Starbridge", "Settings…", "", "Quit Starbridge"]);
  await app.evaluate(() => (globalThis as { menu?: Electron.Menu }).menu?.items[1]?.click());
  await page.waitForURL((u) => u.pathname === "/settings");
  assert.equal(await page.evaluate("window.starbridgeDesktop.login()"), false);

  // Kept in the Dock alone, the menu bar icon goes, and the page reads the choice after a reload.
  type Bridge = { place(): string; setPlace(p: string): void };
  const bridge = () => (window as unknown as { starbridgeDesktop: Bridge }).starbridgeDesktop;
  assert.equal(await page.evaluate(`(${bridge})().place()`), "menu");
  await page.evaluate(`(${bridge})().setPlace("dock")`);
  await until(() => main((g) => g.destroyed === 1), "the menu bar icon to go");
  await page.reload();
  assert.equal(await page.evaluate(`(${bridge})().place()`), "dock");

  // Presence (#945, #1003): the page hears the idle time, lock and sleep.
  type Screen = StandIn["readings"][number];
  const screenBridge = () =>
    (
      window as unknown as {
        starbridgeDesktop: {
          screen(): Screen;
        };
      }
    ).starbridgeDesktop;
  assert.equal(await page.evaluate(`(${screenBridge})().screen().away`), false);
  await until(
    () =>
      page.evaluate(
        () => typeof (window as unknown as StandIn).readings.at(-1)?.idleMs === "number",
      ),
    "the idle time",
  );
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
  await until(() => Promise.resolve(posted.length === 1), "away on lock");
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
  await until(
    () => page.evaluate(() => (window as unknown as StandIn).readings.at(-1)?.away === false),
    "back on unlock",
  );

  // Another origin stays out of the window, opens in the browser only from the owner's click, and
  // never from a frame (#1721).
  await page.evaluate((u) => {
    const frame = document.createElement("iframe");
    frame.src = u;
    document.body.append(frame);
    const a = document.createElement("a");
    a.id = "outside";
    a.href = u;
    a.textContent = "Outside";
    document.body.prepend(a);
  }, url(other));
  await new Promise((done) => setTimeout(done, 500));
  assert.equal(await main((g) => g.outside.length), 0, "no tab without a click");
  const box = await page.locator("#outside").boundingBox();
  assert.ok(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(() => main((g) => g.outside.length === 1), "the link to open outside");
  await page.evaluate((u) => {
    setTimeout(() => {
      location.href = u;
    }, 2_500);
  }, url(other));
  await new Promise((done) => setTimeout(done, 3_000));
  assert.equal(await main((g) => g.outside.length), 1, "no tab from a navigation without a click");
  assert.equal(new URL(page.url()).origin, url(server));
  // Quitting tells the page the owner left, and waits for it.
  await app.close();
  assert.equal(posted.length, 2, "away on quit");

  // On a server that never answers, the error page keeps the server's URL; Settings… opens the
  // server window, the one place left to fix it (#1449).
  const closed = await serve("");
  const gone = url(closed);
  closed.close();
  const offline = await electron.launch({
    args: [DESKTOP, `--user-data-dir=${mkdtempSync(join(tmpdir(), "sb-desktop-"))}`],
    env: { ...process.env, STARBRIDGE_SERVER: gone },
  });
  try {
    await offline.evaluate(({ Tray }) => {
      const g = globalThis as { tray?: Electron.Tray; menu?: Electron.Menu };
      Tray.prototype.popUpContextMenu = (m?: Electron.Menu) => {
        g.menu = m;
      };
      const setImage = Tray.prototype.setImage;
      Tray.prototype.setImage = function (this: Electron.Tray, i: Electron.NativeImage) {
        g.tray = this;
        setImage.call(this, i);
      };
    });
    await until(
      () =>
        offline.evaluate(
          ({ BrowserWindow }, gone) =>
            BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().startsWith(gone)),
          gone,
        ),
      "the failed load",
    );
    // The app may have painted its icon before the patch above: a theme change paints it again.
    await until(
      () =>
        offline.evaluate(({ nativeTheme }) => {
          const g = globalThis as { tray?: Electron.Tray };
          if (!g.tray) nativeTheme.emit("updated");
          return !!g.tray;
        }),
      "the menu bar icon",
    );
    // Clicked until the window shows: the failed load's URL can show before the app has marked
    // the load failed, and Settings… then goes to the page instead (#2211).
    await until(
      () =>
        offline.evaluate(({ BrowserWindow }) => {
          if (BrowserWindow.getAllWindows().some((w) => w.getTitle() === "Server")) return true;
          const g = globalThis as { tray?: Electron.Tray; menu?: Electron.Menu };
          g.tray?.emit("right-click");
          g.menu?.items[1]?.click();
          return false;
        }),
      "the server window",
    );
    // Sized to its content (#1613): shown, with nothing to scroll and nothing cut off.
    await until(
      () =>
        offline.evaluate(async ({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Server");
          if (!w?.isVisible()) return false;
          const [, h] = w.getContentSize();
          const fit = await w.webContents.executeJavaScript(
            "[document.documentElement.scrollHeight, document.querySelector('button[type=submit]').getBoundingClientRect().bottom]",
          );
          return fit[0] <= (h ?? 0) && fit[1] <= (h ?? 0);
        }),
      "the server window to fit its content",
    );
  } finally {
    await offline.close();
  }
  console.log("desktop smoke test passed");
} finally {
  await app.close();
  server.close();
  other.close();
  releases.close();
  rmSync(join(DESKTOP, "dev-app-update.yml"), { force: true });
  rmSync(join(homedir(), MAC ? "Library/Caches" : ".cache", CACHE), {
    recursive: true,
    force: true,
  });
}
