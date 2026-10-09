// The desktop app on the whole product, on one machine: the real server, the built web page, the
// real CLI, and web/e2e/services.ts standing in for GitHub. It signs in through the browser (this
// run follows the browser's redirects) and sets up the app as a device, pairs a machine, and answers `starbridge ask --wait` from the app's notifications: by a
// button and by a typed reply; a question answered in the window closes its notification, and the
// menu bar's climber follows Needs you. Notifications and the tray are watched in the main process.
//
//   xvfb-run -a node desktop/test/stack.ts      (after `pnpm --filter @starbridge/desktop build`)
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const DESKTOP = join(ROOT, "desktop");
const WEB = join(ROOT, "web");
const VERSION = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")).version;
const tmp = mkdtempSync(join(tmpdir(), "starbridge-desktop-stack-"));
const children: ChildProcess[] = [];

const port = (): Promise<number> =>
  new Promise((done) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });
const PORTS = { web: await port(), server: await port(), github: await port(), push: await port() };
const ORIGIN = `http://localhost:${PORTS.web}`;
const SERVER = `http://localhost:${PORTS.server}`;

function start(name: string, cmd: string, args: string[], env: object = {}) {
  const p = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(p);
  let out = "";
  const feed = (chunk: Buffer) => {
    out += chunk.toString();
    for (const line of chunk.toString().split("\n"))
      if (line.trim()) console.log(`[${name}] ${line}`);
  };
  p.stdout.on("data", feed);
  p.stderr.on("data", feed);
  const exited = new Promise<number>((r) => p.on("exit", (code) => r(code ?? -1)));
  return {
    exited,
    kill: () => p.kill(),
    waitFor: (re: RegExp, ms = 30_000) =>
      until(async () => out.match(re), `${name}: ${re}`, ms) as Promise<RegExpMatchArray>,
  };
}

const cli = (name: string, args: string[], home: string) =>
  start(name, "bun", ["run", join(ROOT, "cli/src/main.ts"), ...args], {
    STARBRIDGE_CONFIG_DIR: home,
    STARBRIDGE_SERVER: SERVER,
  });

async function until<T>(f: () => Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function step(text: string) {
  console.log(`\n== ${text}`);
}

/** What the main process records in place of the OS. */
type Watched = {
  shown: Electron.Notification[];
  closed: string[];
  tips: string[];
  /** What the app sent to the owner's browser. */
  outside: string[];
};

try {
  step("services, server, web");
  const services = start("services", "bun", [join(WEB, "e2e/services.ts")], {
    GITHUB_PORT: PORTS.github,
    PUSH_PORT: PORTS.push,
  });
  await services.waitFor(/"event":"ready"/);
  const server = start("server", "bun", ["run", "server/src/main.ts"], {
    PORT: PORTS.server,
    DB_PATH: join(tmp, "starbridge.db"),
    PUBLIC_URL: ORIGIN,
    GITHUB_CLIENT_ID: "stub",
    GITHUB_CLIENT_SECRET: "stub",
    GITHUB_AUTHORIZE_URL: `http://localhost:${PORTS.github}/login/oauth/authorize`,
    GITHUB_TOKEN_URL: `http://localhost:${PORTS.github}/login/oauth/access_token`,
    GITHUB_API_URL: `http://localhost:${PORTS.github}`,
  });
  await server.waitFor(/starbridge server on port/);
  const built = spawnSync("bun", ["run", "build"], {
    cwd: WEB,
    env: { ...process.env, STARBRIDGE_SERVER: SERVER },
    stdio: "inherit",
  });
  if (built.status) throw new Error("web build failed");
  const standalone = join(WEB, ".next/standalone/web");
  cpSync(join(WEB, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  cpSync(join(WEB, "public"), join(standalone, "public"), { recursive: true });
  const web = start("web", "node", [join(standalone, "server.js")], {
    STARBRIDGE_SERVER: SERVER,
    PORT: String(PORTS.web),
    HOSTNAME: "127.0.0.1",
  });
  await web.waitFor(/Ready|started server/i);

  step("the app opens the server's page");
  const app = await electron.launch({
    args: [DESKTOP, `--user-data-dir=${join(tmp, "app")}`],
    env: {
      ...process.env,
      STARBRIDGE_SERVER: ORIGIN,
    },
  });
  app.process().stdout?.on("data", (d) => process.stdout.write(`[app] ${d}`));
  try {
    await app.evaluate(({ Notification, Tray, shell }) => {
      const g = globalThis as Record<string, unknown>;
      const shown: unknown[] = [];
      const closed: string[] = [];
      const tips: string[] = [];
      const outside: string[] = [];
      Object.assign(g, { shown, closed, tips, outside });
      shell.openExternal = async (u: string) => {
        outside.push(u);
      };
      Notification.prototype.show = function (this: Electron.Notification) {
        shown.push(this);
      };
      Notification.prototype.close = function (this: Electron.Notification) {
        closed.push(this.id);
      };
      Tray.prototype.setToolTip = (t: string) => {
        tips.push(t);
      };
    });
    const main = <T>(f: (g: Watched) => T) =>
      app.evaluate(
        (_e, src) => new Function("g", `return (${src})(g)`)(globalThis),
        f.toString(),
      ) as Promise<T>;
    const page = await app.firstWindow();
    page.on("console", (m) => m.type() === "error" && console.log(`[page] ${m.text()}`));
    const headers: string[] = [];
    page.on("request", (r) => {
      const h = r.headers()["starbridge-client"];
      if (h) headers.push(h);
    });

    step("signed out, the app shows sign-in, not the landing page (#905)");
    await page.getByRole("heading", { name: "Sign in to Starbridge" }).waitFor();
    const html = await (await fetch(ORIGIN, { headers: { cookie: "sb_desktop=1" } })).text();
    assert.ok(!html.includes("Know the moment"), "the server sent the app the landing page");
    assert.equal(await page.getByRole("button", { name: "Use your own server" }).count(), 0);
    await page.getByText("Opens your browser.").waitFor();

    step("sign in with GitHub (stub) through the browser, and set up the app as the first device");
    // Clicked in the page: Playwright's click would wait for a navigation the app cancels.
    await page
      .getByRole("link", { name: /^(Sign in|Continue) with GitHub$/ })
      .evaluate((a: HTMLElement) => a.click());
    // The app sends the sign-in to the browser; this run plays the browser, following redirects
    // through GitHub and the server until the starbridge://auth link the browser would open.
    let next = await until(
      async () => (await main((g) => g.outside)).find((u) => u.includes("/v1/auth/github?app=1")),
      "the sign-in sent to the browser",
    );
    while (!next.startsWith("starbridge:")) {
      const res = await fetch(next, { redirect: "manual" });
      const location = res.headers.get("location");
      assert.ok(location, `${next} answered ${res.status} without a redirect`);
      next = new URL(location, next).toString();
    }
    await app.evaluate(({ app }, link) => {
      app.emit("open-url", { preventDefault() {} }, link);
    }, next);
    await page.getByText("This app creates your account's keys.").waitFor();
    assert.match(
      await page.getByLabel("Name this app").inputValue(),
      /^Starbridge on (Mac|Linux)$/,
    );
    await page.getByRole("button", { name: "Create the keys" }).click();
    await page.getByRole("heading", { name: "Save your recovery key" }).waitFor();
    await page.getByLabel(/I wrote this key down/).check();
    await page.getByRole("button", { name: "Continue" }).click();
    // No machine yet, so the inbox says how to add one; its own heading depends on the window's
    // width, which differs between runners.
    await page.getByRole("heading", { name: "Add a machine" }).waitFor();
    // The app notifies; the page offers no Web Push of its own.
    assert.equal(await page.getByRole("button", { name: "Turn on notifications" }).count(), 0);

    step("pair a machine from the app's Devices page");
    const machine = join(tmp, "machine");
    const pair = cli("pair", ["pair", "--name", "devbox"], machine);
    const code = (await pair.waitFor(/Pairing code: (\S+)/))[1] as string;
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("link", { name: "Add a device" }).click();
    await page.getByLabel("Pair a machine or device").fill(code);
    await page.getByRole("button", { name: "Check code" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    // The owner's side of the check code (#795): the window shows what the terminal printed, and
    // `pair --confirm` answers the terminal's question.
    const printed = (await pair.waitFor(/Check code: (\S+)/))[1] as string;
    assert.equal(await page.getByTestId("check-code").textContent(), `Check code ${printed}`);
    assert.equal(
      await cli("confirm", ["pair", "--confirm"], machine).exited,
      0,
      "pair --confirm failed",
    );
    await pair.waitFor(/✓ Paired as devbox/);
    assert.equal(await pair.exited, 0, "pair failed");
    await page.getByRole("link", { name: /^Inbox/ }).click();

    step("a question notifies with its options; a button answers it");
    const ask = (question: string, ...extra: string[]) =>
      cli("ask", ["ask", "--question", question, "--wait", ...extra], machine);
    const first = ask("Ship the desktop app?", "--option", "Ship it", "--option", "Wait");
    const note = await until(
      () =>
        main((g) =>
          g.shown
            .map((n) => ({
              title: n.title,
              actions: n.actions.map((a) => a.text),
              reply: n.hasReply,
            }))
            .find((n) => n.title === "Ship the desktop app?"),
        ),
      "the question's notification",
    );
    assert.deepEqual(note.actions, ["Ship it", "Wait"]);
    await until(
      () => main((g) => g.tips.at(-1) === "Starbridge: 1 needs you"),
      "the amber climber",
    );
    // While the window is hidden, as when closed to the menu bar.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    await main((g) => {
      const n = g.shown.find((n) => n.title === "Ship the desktop app?");
      n?.emit("action", { actionIndex: 1 }, 1);
    });
    await first.waitFor(/Answer to d_\S+ \(Ship the desktop app\?\): Wait/);
    assert.equal(await first.exited, 0);
    await until(
      () => main((g) => g.tips.at(-1) === "Starbridge"),
      "the climber back to one colour",
    );

    step("a typed reply from the notification answers a question without options");
    const second = ask("Which branch should I rebase onto?");
    await until(
      () =>
        main((g) =>
          g.shown.some((n) => n.title === "Which branch should I rebase onto?" && n.hasReply),
        ),
      "the typed question's notification",
    );
    await main((g) => {
      const n = g.shown.find((n) => n.title === "Which branch should I rebase onto?");
      n?.emit("reply", { reply: "main, after #889" }, "main, after #889");
    });
    await second.waitFor(/\): main, after #889/);
    assert.equal(await second.exited, 0);

    step("a question answered in the window closes its notification");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    const third = ask("Merge #888?", "--option", "Merge", "--option", "Hold");
    const id = await until(
      () => main((g) => g.shown.find((n) => n.title === "Merge #888?")?.id),
      "the third notification",
    );
    // The recommended option reads "Merge Default" to a screen reader (#254).
    await page
      .getByRole("button", { name: /^Merge/ })
      .first()
      .click();
    await third.waitFor(/\): Merge/);
    await until(
      async () => (await main((g) => g.closed)).includes(id),
      "the answered notification to close",
    );

    assert.ok(
      headers.length > 0 && headers.every((h) => h === `desktop/${VERSION}`),
      `the page names itself desktop/${VERSION}: ${[...new Set(headers)].join(", ")}`,
    );
    console.log("\ndesktop stack test passed");
  } catch (e) {
    // What the window showed when it failed, beside the run's temporary files.
    const page = app.windows()[0];
    if (page) {
      await page
        .screenshot({ path: join(tmpdir(), "starbridge-desktop-failure.png") })
        .catch(() => {});
      console.log(
        `[failure] ${page.url()}\n${await page
          .locator("body")
          .innerText()
          .catch(() => "")}`,
      );
    }
    throw e;
  } finally {
    await app.close();
  }
} finally {
  for (const c of children) c.kill();
}
