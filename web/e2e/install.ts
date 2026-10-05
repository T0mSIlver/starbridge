// The installed app on iPhone and desktop, checked without either device (#116): WebKit as an
// iPhone shows the Home Screen hint in a Safari tab and none once installed; Chromium audits the
// manifest with its installability check, installs the page and launches it standalone.
//
//   xvfb-run -a -s "-screen 0 1280x860x24" node web/e2e/install.ts   (Node 22.6+ runs it as is)
//
// Needs `npx playwright install webkit chromium` once (and `install-deps webkit` on Linux).
// Writes web/docs/install/*.png. Ports 3880 and 3881 on localhost.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, devices, type Page, webkit } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const WEB = join(ROOT, "web");
const PORTS = { web: 3880, server: 3881 };
const ORIGIN = `http://localhost:${PORTS.web}`;
const OUT = join(WEB, "docs/install");
const TOKEN = "install-check";
const tmp = mkdtempSync(join(tmpdir(), "starbridge-install-"));
const children: ChildProcess[] = [];
/** Browsers to close and the page to capture if a step fails. */
const browsers: { close(): Promise<void> }[] = [];
let current: Page | undefined;

function start(name: string, cmd: string, args: string[], env: object, ready: RegExp) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(p);
  const up = new Promise<void>((done, fail) => {
    let out = "";
    const t = setTimeout(() => fail(new Error(`${name} did not start:\n${out}`)), 30_000);
    const feed = (b: Buffer) => {
      out += b;
      if (ready.test(out)) {
        clearTimeout(t);
        done();
      }
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
  });
  return { proc: p, up };
}

/** A fresh server, so each browser sets up the first device of a new account. */
async function server(db: string) {
  const s = start(
    "server",
    "bun",
    ["run", "server/src/main.ts"],
    { PORT: PORTS.server, DB_PATH: join(tmp, db), PUBLIC_URL: ORIGIN, OWNER_TOKEN: TOKEN },
    /starbridge server on port/,
  );
  await s.up;
  return s.proc;
}

function check(ok: unknown, what: string) {
  if (!ok) throw new Error(what);
  console.log(`ok: ${what}`);
}

/** Signs in with the owner token and makes this browser the first device or opens its Inbox. */
async function setUp(page: Page) {
  current = page;
  page.setDefaultTimeout(30_000);
  page.on("console", (m) => m.type() === "error" && console.log(`[page] ${m.text()}`));
  await page.goto(ORIGIN);
  await page.getByRole("button", { name: /sign in with the owner token/ }).click();
  await page.getByLabel("Owner token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Make keys" }).click();
  await page.getByLabel(/I wrote these words down/).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Inbox" }).waitFor();
}

async function iphone() {
  const browser = await webkit.launch();
  browsers.push(browser);
  const ctx = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await ctx.newPage();
  await setUp(page);
  const hint = page.getByTestId("install-hint");
  await hint.waitFor();
  check(
    await hint.textContent().then((t) => t?.includes("Add to Home Screen")),
    "iPhone tab: hint",
  );
  check(
    (await page.getByRole("button", { name: "Turn on notifications" }).count()) === 0,
    "iPhone tab: no push button",
  );
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(OUT, `hint-iphone-${scheme}.png`) });
  }

  // The tags iOS reads when adding to the Home Screen.
  const head = await page.evaluate(() => ({
    touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"),
    title: document
      .querySelector('meta[name="apple-mobile-web-app-title"]')
      ?.getAttribute("content"),
    statusBar: document
      .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
      ?.getAttribute("content"),
    themeColors: [...document.querySelectorAll('meta[name="theme-color"]')].map(
      (m) => `${m.getAttribute("media")}: ${m.getAttribute("content")}`,
    ),
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href"),
  }));
  check(head.touchIcon && head.title && head.statusBar && head.manifest, "iOS head tags");
  const icon = await page.request.get(new URL(head.touchIcon as string, ORIGIN).href);
  check(icon.ok() && icon.headers()["content-type"] === "image/png", "apple-touch-icon loads");

  // Opened from the Home Screen: WebKit on Linux has no standalone mode, so say so as iOS does.
  await ctx.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  await page.reload();
  await page.getByRole("heading", { name: "Inbox" }).waitFor();
  await page.waitForTimeout(500);
  check((await page.getByTestId("install-hint").count()) === 0, "iPhone Home Screen app: no hint");
  await page.screenshot({ path: join(OUT, "home-screen-iphone-dark.png") });
  await browser.close();
  return head;
}

async function desktop(head: object) {
  const profile = join(tmp, "chrome");
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: null,
    args: ["--window-size=1280,860", "--window-position=0,0"],
  });
  browsers.push(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await setUp(page);
  const cdp = await ctx.newCDPSession(page);
  const errors = (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors;
  const app = await cdp.send("Page.getAppManifest");
  check(
    errors.length === 0,
    `installable (${errors.map((e) => e.errorId).join(", ") || "no errors"})`,
  );
  check(app.errors.length === 0, "manifest parses without warnings");
  const manifest = JSON.parse(app.data ?? "{}");
  const icons = await Promise.all(
    manifest.icons.map(async (i: { src: string; sizes: string; purpose: string }) => {
      const r = await page.request.get(new URL(i.src, ORIGIN).href);
      return `${i.src} ${i.sizes} ${i.purpose} → ${r.status()}`;
    }),
  );
  const maskable = await maskableFits(page);
  check(maskable, "maskable icon: opaque, climber inside the 80% safe zone");

  // The audit as a page, to screenshot.
  const report = await ctx.newPage();
  await report.setViewportSize({ width: 900, height: 1100 });
  const rows = (o: object) =>
    Object.entries(o)
      .map(([k, v]) => `<tr><th>${k}</th><td>${Array.isArray(v) ? v.join("<br>") : v}</td></tr>`)
      .join("");
  writeFileSync(
    join(tmp, "audit.html"),
    `<!doctype html><meta charset=utf-8><style>body{font:14px system-ui;margin:24px;background:#fff;color:#111}
    h1{font-size:20px}h2{font-size:16px;margin-top:20px}th{text-align:left;vertical-align:top;padding:4px 12px 4px 0;white-space:nowrap}
    td{padding:4px 0}.ok{color:#0a7a2f;font-weight:600}</style>
    <h1>Starbridge install audit, Chromium ${ctx.browser()?.version() ?? ""}</h1>
    <p class=ok>Page.getInstallabilityErrors: ${errors.length ? errors.map((e) => e.errorId).join(", ") : "none, installable"}</p>
    <p class=ok>Page.getAppManifest: ${app.errors.length ? app.errors.map((e) => e.message).join(", ") : "no manifest errors or warnings"}</p>
    <p class=ok>Maskable icon: opaque, climber inside the 80% safe zone</p>
    <h2>Manifest (${app.url})</h2><table>${rows({
      id: manifest.id,
      name: manifest.name,
      short_name: manifest.short_name,
      start_url: manifest.start_url,
      scope: manifest.scope,
      display: manifest.display,
      theme_color: manifest.theme_color,
      background_color: manifest.background_color,
      categories: manifest.categories,
      launch_handler: JSON.stringify(manifest.launch_handler),
      shortcuts: manifest.shortcuts.map(
        (s: { name: string; url: string }) => `${s.name} → ${s.url}`,
      ),
      icons,
      screenshots: manifest.screenshots.map(
        (s: { src: string; sizes: string; form_factor: string }) =>
          `${s.src} ${s.sizes} ${s.form_factor}`,
      ),
    })}</table><h2>iOS head tags (WebKit, iPhone 15)</h2><table>${rows(head)}</table>`,
  );
  await report.goto(`file://${join(tmp, "audit.html")}`);
  await report.screenshot({ path: join(OUT, "manifest-audit.png"), fullPage: true });
  await report.close();

  // Install, then launch it as the desktop app does: its own window, no tabs or address bar.
  const id = new URL(manifest.id, ORIGIN).href;
  await cdp.send("PWA.install", { manifestId: id });
  // An install over CDP opens in a tab until told otherwise; the install button opens a window.
  await cdp.send("PWA.changeAppUserSettings", { manifestId: id, displayMode: "standalone" });
  // Close the tab, so the launch opens the app's own window; a blank tab keeps Chrome open.
  const blank = await ctx.newPage();
  const browserCdp = await ctx.newCDPSession(blank);
  await page.close();
  const opened = ctx.waitForEvent("page");
  await browserCdp.send("PWA.launch", { manifestId: id });
  const appPage = await opened;
  appPage.setDefaultTimeout(30_000);
  await appPage.getByRole("heading", { name: "Inbox" }).waitFor();
  check(
    await appPage.evaluate(() => matchMedia("(display-mode: standalone)").matches),
    "launched app runs standalone",
  );
  // A second launch, as from the Quotas shortcut, reuses that window (launch_handler).
  await browserCdp.send("PWA.launch", { manifestId: id, url: `${ORIGIN}/quotas` });
  await appPage.getByRole("heading", { name: "Quotas" }).waitFor();
  check(ctx.pages().length === 2, "the Quotas shortcut opens in the same window");
  check((await appPage.title()) === "Starbridge · Quotas", "app window title");
  await blank.close();
  await appPage.waitForTimeout(1000);
  // The whole screen, so the app window's own frame shows.
  spawnSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "x11grab",
    "-video_size",
    "1280x860",
    "-i",
    process.env.DISPLAY as string,
    "-frames:v",
    "1",
    join(OUT, "standalone-desktop.png"),
  ]);
  await ctx.close();
}

/**
 * The maskable icon fills its square with no transparency, and its climber (the amber, the
 * part a mask must not cut) sits inside the central 80% circle. The planet and the tether run
 * off the edges by design, as on the Android adaptive icon.
 */
async function maskableFits(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const img = new Image();
    img.src = "/icon-maskable-512.png";
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, img.width, img.height);
    const r = (width * 0.4) ** 2;
    let amber = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [red, green, blue, alpha] = [
          data[i],
          data[i + 1],
          data[i + 2],
          data[i + 3],
        ] as number[];
        if (alpha !== 255) return false;
        if (red > 200 && green > 120 && green < 200 && blue < 100) {
          amber++;
          if ((x - width / 2) ** 2 + (y - height / 2) ** 2 > r) return false;
        }
      }
    return amber > 0;
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const first = await server("iphone.db");
  const env = { STARBRIDGE_SERVER: `http://localhost:${PORTS.server}` };
  if (
    spawnSync("bun", ["run", "build"], {
      cwd: WEB,
      env: { ...process.env, ...env },
      stdio: "inherit",
    }).status
  )
    throw new Error("web build failed");
  const standalone = join(WEB, ".next/standalone/web");
  cpSync(join(WEB, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  cpSync(join(WEB, "public"), join(standalone, "public"), { recursive: true });
  await start(
    "web",
    "node",
    [join(standalone, "server.js")],
    { ...env, PORT: String(PORTS.web), HOSTNAME: "127.0.0.1" },
    /Ready|started server/i,
  ).up;
  const head = await iphone();
  first.kill();
  await new Promise((r) => first.once("exit", r));
  await server("desktop.db");
  await desktop(head);
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
  await current
    ?.screenshot({ path: join(tmp, "..", "starbridge-install-failure.png") })
    .catch(() => {});
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  for (const p of children) p.kill();
  rmSync(tmp, { recursive: true, force: true });
}
