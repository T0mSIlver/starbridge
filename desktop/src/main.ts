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
  session,
  shell,
  Tray,
  type WebContents,
} from "electron";
import { type Answer, type Entry, parseAnswered, parseState } from "./bridge";
import { Notifier, type Shown } from "./notifier";
import { linkPage, opensOutside, serverOrigin, staysInWindow } from "./origin";
import { readSettings, type Settings, writeSettings } from "./settings";

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
let notifier: Notifier;
let quitting = false;
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
  settings = readSettings(SETTINGS);
  origin = process.env.STARBRIDGE_SERVER
    ? (serverOrigin(process.env.STARBRIDGE_SERVER) ?? settings.server)
    : settings.server;
  notifier = new Notifier(notify, settings.notified, (ids) => {
    settings.notified = ids;
    save();
  });

  const ses = session.fromPartition("persist:starbridge");
  // The page copies codes and keys; it asks for nothing else, and notifies through the app.
  ses.setPermissionRequestHandler((wc, permission, done) =>
    done(fromServer(wc.getURL()) && permission === "clipboard-sanitized-write"),
  );
  ses.setPermissionCheckHandler(
    (_wc, permission, requesting) =>
      fromServer(requesting) && permission === "clipboard-sanitized-write",
  );

  ipcMain.on("state", (e, x) => {
    const state = fromPage(e) && parseState(x);
    if (!state) return;
    tray?.setTitle(state.count > 0 ? String(state.count) : "");
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
  if (!atLogin) showWindow();
  for (const link of early.splice(0)) openLink(link);
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
  // Offline at start, or the server restarting: try again, unless a newer navigation came first.
  let retry: NodeJS.Timeout | undefined;
  win.webContents.on("did-start-navigation", (d) => {
    if (d.isMainFrame) clearTimeout(retry);
  });
  win.webContents.on("did-fail-load", (_e, code, _desc, url, mainFrame) => {
    // -3 is a navigation the page or the app cancelled.
    if (mainFrame && code !== -3) retry = setTimeout(() => win?.loadURL(url), 5_000);
  });
  win.loadURL(origin);
}

/** Every web contents: no new windows, and only the server's and GitHub's pages inside. */
function guard(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (opensOutside(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  const leave = (e: { preventDefault(): void; url: string }) => {
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
  const icon = nativeImage.createFromPath(join(ASSETS, "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Starbridge");
  tray.on("click", showWindow);
  tray.on("right-click", () => tray?.popUpContextMenu(menu()));
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
    { type: "separator" },
    { label: "Quit Starbridge", role: "quit" },
  ]);
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
  const page = linkPage(link, origin);
  if (!page) return;
  if ("refused" in page) {
    dialog.showMessageBox({ type: "warning", message: "Link not opened", detail: page.refused });
    return;
  }
  win.loadURL(page.url);
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
