import { enableCompileCache } from "node:module";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  type IpcMainEvent,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  net,
  session,
  shell,
  Tray,
  type WebContents,
} from "electron";
import { type Answer, type Entry, parseAnswered, parseState } from "./bridge";
import { Notifier, type Shown } from "./notifier";
import { linkPage, opensOutside, serverOrigin, staysInWindow } from "./origin";
import { readSettings, type Settings, writeSettings } from "./settings";
import { browserSignIn, newSignIn, type SignIn, signInReturn, startsSignIn } from "./signin";
import { mark, timing } from "./timing";

mark("main");

// The bundler fixes __dirname at build time, so paths start from the app's own folder.
const ROOT = app.getAppPath();
const ASSETS = join(ROOT, "assets");
const SETTINGS = join(app.getPath("userData"), "settings.json");
/** How long the page has to say an answer from a notification went out. */
const ANSWER_MS = 30_000;

let settings: Settings;
let origin: string;
let win: BrowserWindow | null = null;
let serverWin: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Items in Needs you, which turn the menu bar's climber amber. */
let needs = 0;
let notifier: Notifier;
let quitting = false;
/** The GitHub sign-in sent to the browser, until its link comes back. */
let signIn: SignIn | null = null;
/** A release downloaded, which installs on quit or from Restart to Update. */
let update: { install(): void } | null = null;
let updateReady = false;
/** Links that arrived before the window existed. */
const early: string[] = [];
/** Answers handed to the page, until it says they went out. */
const pending = new Map<string, NodeJS.Timeout>();

if (!app.requestSingleInstanceLock()) app.quit();
else start();

function start(): void {
  app.enableSandbox();
  // A development run would register the bare Electron binary as the handler.
  if (app.isPackaged) app.setAsDefaultProtocolClient("starbridge");
  app.on("open-url", (e, url) => {
    e.preventDefault();
    openLink(url);
  });
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith("starbridge:"));
    if (link) openLink(link);
    else showWindow();
  });
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  // The app lives in the menu bar; closing the window keeps it there.
  app.on("window-all-closed", () => {});
  app.on("web-contents-created", (_e, contents) => guard(contents));
  app.whenReady().then(ready);
}

function ready(): void {
  mark("ready");
  settings = readSettings(SETTINGS);
  origin = process.env.STARBRIDGE_SERVER
    ? (serverOrigin(process.env.STARBRIDGE_SERVER) ?? settings.server)
    : settings.server;
  notifier = new Notifier(notify, settings.notified, (ids) => {
    settings.notified = ids;
    save();
  });

  const ses = session.fromPartition("persist:starbridge");
  // The page copies codes and keys, and shows quota alerts as web notifications; items notify
  // through the bridge instead. It gets nothing else.
  const allowed = ["clipboard-sanitized-write", "notifications"];
  ses.setPermissionRequestHandler((wc, permission, done) =>
    done(fromServer(wc.getURL()) && allowed.includes(permission)),
  );
  ses.setPermissionCheckHandler(
    (_wc, permission, requesting) => fromServer(requesting) && allowed.includes(permission),
  );

  ipcMain.on("state", (e, x) => {
    const state = fromPage(e) && parseState(x);
    if (!state) return;
    needs = state.count;
    paintTray();
    notifier.update(state.entries);
  });
  ipcMain.on("answered", (e, x) => {
    const a = fromPage(e) && parseAnswered(x);
    if (!a || !pending.has(a.id)) return;
    clearTimeout(pending.get(a.id));
    pending.delete(a.id);
    if (a.error) notSent(a.id, a.error);
    else notifier.close(a.id);
  });
  ipcMain.on("server", (e, x) => {
    if (e.sender !== serverWin?.webContents || typeof x !== "string") return;
    const next = serverOrigin(x);
    if (!next) {
      e.sender.send("server-error", "Enter an https:// address.");
      return;
    }
    if (next === settings.server) return serverWin?.close();
    settings = { ...settings, server: next, notified: [] };
    save();
    app.relaunch();
    app.exit();
  });

  createWindow();
  createTray();
  if (!globalShortcut.register(settings.shortcut, showWindow))
    console.warn(`shortcut ${settings.shortcut} is taken`);
  const atLogin = process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin;
  if (atLogin) app.dock?.hide();
  else showWindow();
  for (const link of early.splice(0)) openLink(link);
  checkForUpdates();
}

function checkForUpdates(): void {
  if (!app.isPackaged) return;
  // Loaded late and by path, so the bundler keeps it out of main.js (src/updater.ts).
  setTimeout(() => {
    // Node keeps the compiled updater on disk, so later starts skip compiling its 0.5 MB.
    enableCompileCache();
    const { startUpdates } = require(
      join(ROOT, "dist", "updater.js"),
    ) as typeof import("./updater");
    update = startUpdates(() => {
      updateReady = true;
    });
  }, 5_000);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: "Starbridge",
    backgroundColor: "#0c0c0c",
    webPreferences: {
      preload: join(ROOT, "dist", "preload.js"),
      partition: "persist:starbridge",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A hidden window keeps reading the inbox, so notifications arrive on time.
      backgroundThrottling: false,
      additionalArguments: [
        `--starbridge-origin=${origin}`,
        `--starbridge-version=${app.getVersion()}`,
      ],
    },
  });
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  // A Dock icon only while the window is open; closed, the app is its menu bar icon.
  win.on("hide", () => app.dock?.hide());
  // Offline at start, or the server restarting: try again, unless a newer navigation came first.
  let retry: NodeJS.Timeout | undefined;
  win.webContents.on("did-start-navigation", (d) => {
    if (d.isMainFrame) clearTimeout(retry);
  });
  win.webContents.on("did-fail-load", (_e, code, _desc, url, mainFrame) => {
    // -3 is a navigation the page or the app cancelled.
    if (mainFrame && code !== -3) retry = setTimeout(() => win?.loadURL(url), 5_000);
  });
  win.once("show", () => mark("shown"));
  win.once("ready-to-show", () => mark("painted"));
  win.webContents.once("did-finish-load", () => {
    mark("loaded");
    if (!timing) return;
    // As if closed to the menu bar, so that launching the app again measures a warm open.
    setTimeout(() => win?.hide(), 1_000);
    setTimeout(reportMemory, 10_000);
  });
  // The page's signed-out screen in the app is sign-in, not the landing page (web: DESKTOP_COOKIE).
  session
    .fromPartition("persist:starbridge")
    .cookies.set({
      url: origin,
      name: "sb_desktop",
      value: "1",
      path: "/",
      sameSite: "lax",
      secure: origin.startsWith("https:"),
      expirationDate: Date.now() / 1000 + 365 * 86_400,
    })
    .catch(() => {})
    .finally(() => win?.loadURL(origin));
}

/** The app's memory once idle: every process's working set, as Activity Monitor adds it up. */
function reportMemory(): void {
  const kb = app.getAppMetrics().reduce((sum, p) => sum + p.memory.workingSetSize, 0);
  mark("memory", { mb: Math.round(kb / 1024) });
}

/** Every web contents: no new windows, and only the server's and GitHub's pages inside. */
function guard(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (opensOutside(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  const leave = (e: { preventDefault(): void; url: string }) => {
    if (contents === win?.webContents && startsSignIn(e.url, origin)) {
      e.preventDefault();
      signIn = newSignIn();
      shell.openExternal(browserSignIn(origin, signIn));
      return;
    }
    if (staysInWindow(e.url, origin) && contents === win?.webContents) return;
    e.preventDefault();
    if (opensOutside(e.url)) shell.openExternal(e.url);
  };
  contents.on("will-navigate", leave);
  contents.on("will-redirect", leave);
  contents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame) leave(e);
  });
  contents.on("will-attach-webview", (e) => e.preventDefault());
}

function createTray(): void {
  tray = new Tray(trayIcon());
  paintTray();
  nativeTheme.on("updated", paintTray);
  tray.on("click", showWindow);
  tray.on("right-click", () => tray?.popUpContextMenu(menu()));
}

/**
 * The mark in the menu bar: one colour, as macOS draws menu bar icons, until something needs the
 * owner; then its climber is amber, the one amber light, as on the phone. No count: the window
 * says what. The amber icon carries its own colours, so it follows the menu bar's appearance.
 */
function trayIcon(): Electron.NativeImage {
  const name =
    needs === 0
      ? "trayTemplate"
      : nativeTheme.shouldUseDarkColors
        ? "trayWaitingDark"
        : "trayWaitingLight";
  const icon = nativeImage.createFromPath(join(ASSETS, `${name}.png`));
  icon.setTemplateImage(needs === 0);
  return icon;
}

function paintTray(): void {
  if (!tray) return;
  tray.setImage(trayIcon());
  tray.setToolTip(
    needs === 0 ? "Starbridge" : `Starbridge: ${needs} need${needs === 1 ? "s" : ""} you`,
  );
}

function menu(): Menu {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: "Open Starbridge", accelerator: settings.shortcut, click: showWindow },
    { type: "separator" },
    {
      label: "Open at Login",
      type: "checkbox",
      checked: login,
      click: () => app.setLoginItemSettings({ openAtLogin: !login }),
    },
    { label: `Server: ${new URL(origin).host}…`, click: showServer },
    ...(updateReady ? [{ label: "Restart to Update", click: installUpdate }] : []),
    { type: "separator" },
    { label: "Quit Starbridge", role: "quit" },
  ]);
}

/** Quits for the update: the window must close, not hide, or the install never starts. */
function installUpdate(): void {
  quitting = true;
  update?.install();
}

function showWindow(): void {
  if (!win) return;
  const from = performance.now();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // After the window: bringing the Dock icon back is slow, and the window need not wait for it.
  app.dock?.show();
  // From the click to the next frame the page draws: how fast a warm open feels.
  if (timing && win.webContents.getURL())
    win.webContents
      .executeJavaScript("new Promise((r) => requestAnimationFrame(() => r(1)))")
      .then(() => {
        mark("opened", { ms: Math.round(performance.now() - from) });
        // Hidden again, so the next launch of test/perf.ts measures a warm open too.
        setTimeout(() => win?.hide(), 300);
      })
      .catch(() => {});
}

function showServer(): void {
  if (serverWin) {
    serverWin.focus();
    return;
  }
  serverWin = new BrowserWindow({
    width: 420,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Server",
    webPreferences: {
      preload: join(ROOT, "dist", "server-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--starbridge-server=${settings.server}`],
    },
  });
  serverWin.on("closed", () => {
    serverWin = null;
  });
  serverWin.loadFile(join(ASSETS, "server.html"));
}

function notify(entry: Entry): Shown {
  const n = new Notification({
    id: `item-${entry.id}`,
    title: entry.title,
    body: entry.body,
    actions: entry.options.map((text) => ({ type: "button" as const, text })),
    hasReply: entry.reply,
    replyPlaceholder: "Reply",
  });
  n.on("click", () => open(entry.id));
  n.on("action", (d) => {
    const choice = entry.options[d.actionIndex];
    if (choice !== undefined) answer({ id: entry.id, choice });
  });
  n.on("reply", (d) => {
    if (d.reply.trim()) answer({ id: entry.id, text: d.reply });
  });
  n.show();
  return n;
}

/** Hands an answer to the page, which sends it as if tapped there. */
function answer(a: Answer): void {
  if (!win || !fromServer(win.webContents.getURL())) {
    notSent(a.id, "Starbridge is not signed in.");
    return;
  }
  clearTimeout(pending.get(a.id));
  pending.set(
    a.id,
    setTimeout(() => {
      pending.delete(a.id);
      notSent(a.id, "Starbridge did not answer in time.");
    }, ANSWER_MS),
  );
  win.webContents.send("answer", a);
}

/** Failure notices, kept until closed: macOS drops a collected notification and its handlers. */
const notices = new Set<Notification>();

function notSent(id: string, why: string): void {
  const n = new Notification({ title: "Answer not sent", body: why });
  notices.add(n);
  n.on("click", () => {
    notices.delete(n);
    open(id);
  });
  n.on("close", () => notices.delete(n));
  n.show();
}

/** Shows the window on an item. */
function open(id: string): void {
  showWindow();
  if (win && fromServer(win.webContents.getURL())) win.webContents.send("open", id);
}

function openLink(link: string): void {
  if (!win) {
    early.push(link);
    return;
  }
  const back = signInReturn(link, signIn);
  if (back && signIn) {
    const { verifier } = signIn;
    signIn = null;
    finishSignIn(back, verifier);
    return;
  }
  const page = linkPage(link, origin);
  if (!page) return;
  if ("refused" in page) {
    dialog.showMessageBox({ type: "warning", message: "Link not opened", detail: page.refused });
    return;
  }
  win.loadURL(page.url);
  showWindow();
}

/**
 * Trades GitHub's code and the verifier for a session, which becomes the page's session cookie,
 * as the server would have set it. A failure lands on the page's sign-in, which says why.
 */
async function finishSignIn(
  back: { code: string } | { error: string },
  verifier: string,
): Promise<void> {
  let why = "declined";
  if ("code" in back) {
    try {
      const res = await net.fetch(`${origin}/v1/auth/app/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "starbridge-client": `desktop/${app.getVersion()}`,
        },
        body: JSON.stringify({ code: back.code, verifier }),
      });
      const { session: token } = (await res.json()) as { session?: unknown };
      if (res.ok && typeof token === "string") {
        await session.fromPartition("persist:starbridge").cookies.set({
          url: origin,
          name: "sb_session",
          value: token,
          httpOnly: true,
          secure: origin.startsWith("https:"),
          sameSite: "lax",
          path: "/",
          expirationDate: Date.now() / 1000 + 365 * 86_400,
        });
        win?.loadURL(origin);
        showWindow();
        return;
      }
      why = res.status === 403 ? "paused" : res.status === 429 ? "limited" : "failed";
    } catch {
      why = "failed";
    }
  }
  win?.loadURL(`${origin}/?signin=${why}`);
  showWindow();
}

function fromServer(url: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Only the window's top frame, on the server's own page, talks to the app. */
function fromPage(e: IpcMainEvent): boolean {
  const frame = e.senderFrame;
  return (
    !!win &&
    e.sender === win.webContents &&
    frame === win.webContents.mainFrame &&
    fromServer(frame.url)
  );
}

function save(): void {
  try {
    writeSettings(SETTINGS, settings);
  } catch (e) {
    console.warn("settings not saved", e);
  }
}
