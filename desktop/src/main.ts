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
  powerMonitor,
  session,
  shell,
  Tray,
  type WebContents,
} from "electron";
import { type Answer, type Entry, parseAnswered, parseState } from "./bridge";
import { Notifier, type Shown } from "./notifier";
import { linkPage, opensOutside, serverOrigin, staysInWindow } from "./origin";
import { type Reading, SCREEN_CHECK_MS, Screen } from "./screen";
import { parsePlace, readSettings, type Settings, writeSettings } from "./settings";
import { browserSignIn, newSignIn, type SignIn, signInReturn, startsSignIn } from "./signin";
import { mark, timing } from "./timing";

mark("main");

// The bundler fixes __dirname at build time, so paths start from the app's own folder.
const ROOT = app.getAppPath();
const ASSETS = join(ROOT, "assets");
const SETTINGS = join(app.getPath("userData"), "settings.json");
/** How long the page has to say an answer from a notification went out. */
const ANSWER_MS = 30_000;
/** How long a quitting app waits for the page to say the owner left. */
const QUIT_MS = 2_000;

let settings: Settings;
let origin: string;
let win: BrowserWindow | null = null;
let serverWin: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Items in Needs you, which turn the menu bar's climber amber. */
let needs = 0;
let notifier: Notifier;
let quitting = false;
/** The Mac's lock, sleep and, once allowed, idle time, which the page counts as presence. */
let screen: Screen | null = null;
/** The page being told the owner left, which the app does once, before it quits. */
let leaving: Promise<void> | null = null;
/** Whether the page said so, or `QUIT_MS` passed: the app may go. */
let left = false;
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
  app.on("before-quit", (e) => {
    quitting = true;
    if (left || !screen) return;
    e.preventDefault();
    leave().then(() => app.quit());
  });
  // The app lives in the menu bar; closing the window keeps it there.
  app.on("window-all-closed", () => {});
  app.on("web-contents-created", (_e, contents) => guard(contents));
  app.whenReady().then(ready);
}

async function ready(): Promise<void> {
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
  // Not secret, and asked while the page is still loading, so only the window is checked.
  ipcMain.on("place?", (e) => {
    e.returnValue = e.sender === win?.webContents ? settings.place : null;
  });
  ipcMain.on("place", (e, x) => {
    const place = fromPage(e) && parsePlace(x);
    if (!place || place === settings.place) return;
    settings.place = place;
    save();
    applyPlace();
    win?.webContents.send("place", place);
  });
  screen = new Screen(powerMonitor, tellScreen, settings.presence);
  setInterval(() => screen?.check(), SCREEN_CHECK_MS);
  ipcMain.on("screen?", (e) => {
    e.returnValue = e.sender === win?.webContents ? screen?.read() : null;
  });
  ipcMain.on("presence?", (e) => {
    e.returnValue = e.sender === win?.webContents ? settings.presence : null;
  });
  ipcMain.on("presence", (e, on) => {
    if (!fromPage(e) || typeof on !== "boolean" || on === settings.presence) return;
    settings.presence = on;
    save();
    screen?.setIdle(on);
    win?.webContents.send("presence", on);
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
    leave().then(() => {
      app.relaunch();
      app.exit();
    });
  });

  // The page's signed-out screen in the app is sign-in, not the landing page (web: DESKTOP_COOKIE).
  // Set before the window loads anything, so a link that started the app keeps its own page.
  await ses.cookies
    .set({
      url: origin,
      name: "sb_desktop",
      value: "1",
      path: "/",
      sameSite: "lax",
      secure: origin.startsWith("https:"),
      expirationDate: Date.now() / 1000 + 365 * 86_400,
    })
    .catch(() => {});
  createWindow();
  applyPlace();
  nativeTheme.on("updated", paintTray);
  askNotificationsAfterSignIn(ses);
  if (!globalShortcut.register(settings.shortcut, showWindow))
    console.warn(`shortcut ${settings.shortcut} is taken`);
  const atLogin = process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin;
  if (atLogin) {
    if (settings.place === "menu") app.dock?.hide();
  } else showWindow();
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
      paintDockMenu();
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
    // No title bar on macOS (owner's picks from mockups, #938, #1006): the page runs up to the
    // window's buttons, centred on the rail's mark, and a strip under them drags the window.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 12, y: 20 } }
      : {}),
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
        ...(process.platform === "darwin" ? ["--starbridge-titlebar=inset"] : []),
      ],
    },
  });
  // The window keeps the app's name, for Mission Control and the Window menu, whatever page shows.
  win.on("page-title-updated", (e) => e.preventDefault());
  win.on("close", (e) => {
    // Quitting, the window closes once the page has said the owner left.
    if (quitting && (left || !screen)) return;
    e.preventDefault();
    win?.hide();
  });
  // In the menu bar, a Dock icon only while the window is open; closed, the app is its icon there.
  win.on("hide", () => {
    if (settings.place === "menu") app.dock?.hide();
  });
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
  win.loadURL(origin);
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

/**
 * Puts the app where the owner keeps it (Settings, "Keep Starbridge in"): the menu bar icon unless
 * the Dock alone, and the Dock icon always unless the menu bar alone, where it shows only with
 * the window. The Dock's menu holds the menu bar's items, for when there is no menu bar icon.
 */
function applyPlace(): void {
  if (settings.place === "dock") {
    tray?.destroy();
    tray = null;
  } else if (!tray) {
    tray = new Tray(trayIcon());
    paintTray();
    tray.on("click", showWindow);
    tray.on("right-click", () => tray?.popUpContextMenu(menu()));
  }
  if (settings.place !== "menu" || win?.isVisible()) app.dock?.show();
  else app.dock?.hide();
  paintDockMenu();
}

function paintDockMenu(): void {
  app.dock?.setMenu(menu(false));
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

/** The menu bar icon's menu; the Dock's leaves out Open and Quit, which macOS adds there. */
function menu(forTray = true): Menu {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    ...(forTray
      ? [
          { label: "Open Starbridge", accelerator: settings.shortcut, click: showWindow },
          { type: "separator" as const },
        ]
      : []),
    {
      label: "Open at Login",
      type: "checkbox",
      checked: login,
      click: () => {
        app.setLoginItemSettings({ openAtLogin: !login });
        paintDockMenu();
      },
    },
    { label: `Server: ${new URL(origin).host}…`, click: showServer },
    ...(updateReady ? [{ label: "Restart to Update", click: installUpdate }] : []),
    ...(forTray
      ? [{ type: "separator" as const }, { label: "Quit Starbridge", role: "quit" as const }]
      : []),
  ]);
}

/** Quits for the update: the window must close, not hide, or the install never starts. */
function installUpdate(): void {
  quitting = true;
  leave().then(() => update?.install());
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
  // Refused, as before the owner allows notifications: the page's next update tries again.
  n.on("failed", () => notifier.forget(entry.id));
  n.show();
  return n;
}

/**
 * Electron asks macOS to allow notifications the first time it touches them, which was the first
 * question: shown while macOS still asked, it reached only the window. So the app asks once
 * the page has a session (its sign-in, in the browser or the page), after a line saying why.
 */
function askNotificationsAfterSignIn(ses: Electron.Session): void {
  if (process.platform !== "darwin" || settings.notificationsAsked) return;
  const host = new URL(origin).hostname;
  const isSession = (c: Electron.Cookie) =>
    c.name === "sb_session" && c.domain?.replace(/^\./, "") === host;
  const onChange = (_e: unknown, c: Electron.Cookie, _cause: string, removed: boolean) => {
    if (!removed && isSession(c)) ask();
  };
  let asking = false;
  const ask = () => {
    ses.cookies.off("changed", onChange);
    if (asking) return;
    asking = true;
    const go = () => {
      if (!win) return;
      // Saved once the sheet shows: an app that quits before then asks at its next start.
      settings.notificationsAsked = true;
      save();
      dialog
        .showMessageBox(win, {
          message: "Allow notifications",
          detail: "Each question from your agents shows as a notification you answer with a tap.",
          buttons: ["Continue"],
        })
        // Electron asks macOS when it first needs notifications; this is that first need.
        .then(() => Notification.isSupported());
    };
    if (win?.isVisible()) go();
    else win?.once("show", go);
  };
  ses.cookies.on("changed", onChange);
  ses.cookies.get({ url: origin, name: "sb_session" }).then(
    (c) => {
      if (c.length > 0) ask();
    },
    () => {},
  );
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

/** Numbers each reading, so the page's word on one is not taken for another's. */
let told = 0;

function tellScreen(r: Reading): void {
  told++;
  if (win && fromServer(win.webContents.getURL())) win.webContents.send("screen", r, told);
}

/**
 * Tells the page the owner left before the app goes, so the other devices need not wait out its
 * last beat (75 s), and waits until it says so or `QUIT_MS` passed.
 */
function leave(): Promise<void> {
  if (!screen) return Promise.resolve();
  leaving ??= tellLeft().then(() => {
    left = true;
  });
  return leaving;
}

function tellLeft(): Promise<void> {
  const page = win && fromServer(win.webContents.getURL());
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      ipcMain.off("screen-told", heard);
      done();
    };
    // The quit's reading is the next one told.
    const last = told + 1;
    const heard = (e: IpcMainEvent, n: unknown) => {
      if (fromPage(e) && n === last) finish();
    };
    const timer = setTimeout(finish, page ? QUIT_MS : 0);
    ipcMain.on("screen-told", heard);
    screen?.quit();
  });
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
