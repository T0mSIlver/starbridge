// The desktop app on the whole product, on one machine: the real server, the built web page, the
// real CLI, and web/e2e/services.ts standing in for GitHub. It signs in through the browser (this
// run follows the browser's redirects) and sets up the app as a device, pairs a machine, times the
// switch between tabs, and answers `starbridge ask --wait` from the app's notifications: by a
// button and by a typed reply; a question answered in the window closes its notification, a pasted
// reply stops at 4000 characters (#1921), and the menu bar's dot follows Needs you. Notifications
// and the tray are watched in the main process.
//
//   xvfb-run -a node desktop/test/stack.ts      (after `pnpm --filter @starbridge/desktop build`)
//
// EVIDENCE=<folder> keeps a pull request's evidence there (docs/ci.md, "Evidence"): the window at
// each stop in light and dark, beside each screenshot the boxes of what changes from run to run
// (web/e2e/volatile.ts), and manifest.json, the steps driven and the result.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import {
  boot,
  cli,
  followSignIn,
  ORIGIN,
  ROOT,
  shutdown,
  step,
  steps,
  tmp,
} from "../../web/e2e/stack.ts";
import { volatile } from "../../web/e2e/volatile.ts";

const DESKTOP = join(ROOT, "desktop");
const VERSION = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")).version;

async function until<T>(f: () => Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const EVIDENCE = process.env.EVIDENCE;

function manifest(error?: unknown) {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(
    join(EVIDENCE, "manifest.json"),
    `${JSON.stringify(
      {
        shard: "app",
        passed: error === undefined,
        error: error === undefined ? undefined : String(error).slice(0, 2000),
        steps,
      },
      null,
      2,
    )}\n`,
  );
}

/** The page's size and the main window's content size, which a shot needs equal (#1970). */
async function sizes(app: ElectronApplication, page: Page) {
  const inner = await page.evaluate(() => [innerWidth, innerHeight]);
  const content = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === "Starbridge")
      ?.getContentSize(),
  );
  return { inner, content };
}

/**
 * Gives the page the window the Mac shows, 1200 x 800 with no menu bar in it (#1970). Under xvfb,
 * Linux's menu bar takes 27 px of the window, and the page did not always follow: some shots were
 * 800 px tall with the window's 773 painted, the last 27 rows repeating the brand at the top.
 * Hiding the bar and nudging the size until the page and the window agree removes both.
 */
async function fit(app: ElectronApplication, page: Page) {
  await until(
    async () => {
      const { inner, content } = await sizes(app, page);
      if (inner[1] === 800 && content?.[1] === 800) return true;
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Starbridge");
        w?.setMenuBarVisibility(false);
        w?.setContentSize(1200, 799);
        w?.setContentSize(1200, 800);
      });
      await new Promise((r) => setTimeout(r, 300));
      return false;
    },
    "the page filling a 1200 x 800 window",
    10_000,
  );
}

/**
 * The window as it is, in light then dark (the page's prefers-color-scheme, set through
 * Playwright: Electron's nativeTheme.themeSource did not reach the page under xvfb), as
 * `<stop>-<scheme>.png` with the boxes to leave out of the comparison with main's beside it.
 */
async function shoot(app: ElectronApplication, page: Page, stop: string) {
  if (!EVIDENCE) return;
  // The page fills the window as on the Mac, 1200 x 800 (#1970).
  await fit(app, page);
  assert.deepEqual(await sizes(app, page), { inner: [1200, 800], content: [1200, 800] });
  const dir = join(EVIDENCE, "shots");
  mkdirSync(dir, { recursive: true });
  try {
    for (const scheme of ["light", "dark"] as const) {
      // Without motion, and the pointer in a corner: under xvfb the pointer sits mid-screen, over
      // the sign-in button in some runs, which draws its hover colour or the fade to it.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.mouse.move(0, 799);
      await page.waitForFunction(
        (dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark,
        scheme === "dark",
      );
      // The page repaints its background and the app's colours on the change.
      await new Promise((r) => setTimeout(r, 500));
      const file = join(dir, `${stop}-${scheme}`);
      // Some runs still paint a 773 px window although the page and the window say 800: a shot
      // of another size is nudged to the size again and taken again.
      for (let tries = 1; ; tries++) {
        const png = await page.screenshot({ path: `${file}.png` });
        if (png.readUInt32BE(20) === 800 || tries === 5) break;
        await app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Starbridge");
          w?.setMenuBarVisibility(false);
          w?.setContentSize(1200, 801);
          w?.setContentSize(1200, 800);
        });
        await new Promise((r) => setTimeout(r, 500));
      }
      writeFileSync(`${file}.json`, JSON.stringify(await volatile(page, false)));
    }
  } finally {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  }
}

/**
 * A warm switch between tabs, from the click to the frame that paints the new page: the median of
 * WARM_SWITCHES per tab, since one switch on a busy shared runner can stall (432 ms, #1581).
 */
const SWITCH_MS = 100;
const WARM_SWITCHES = 5;

/**
 * Clicks a tab of the rail, in the page, and resolves with the time to the frame painting the
 * page's heading and more.
 */
function switchTab([tab, heading]: readonly [string, string]): Promise<number> {
  return new Promise((done, fail) => {
    const link = [...document.querySelectorAll('nav[aria-label="Main"] a')].find((a) =>
      (a.textContent ?? "").trim().startsWith(tab),
    ) as HTMLElement | undefined;
    if (!link) return fail(new Error(`no ${tab} tab`));
    const shows = () =>
      [...document.querySelectorAll("h1")].some((h) => h.textContent === heading) &&
      (document.querySelector("main")?.textContent ?? "").trim().length > heading.length;
    const t0 = performance.now();
    const tick = () => {
      if (performance.now() - t0 > 10_000) return fail(new Error(`${tab} never showed`));
      // The frame that paints it is the next one.
      if (shows()) requestAnimationFrame(() => done(performance.now() - t0));
      else requestAnimationFrame(tick);
    };
    link.click();
    requestAnimationFrame(tick);
  });
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
  await boot({ push: false });

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
    await shoot(app, page, "sign-in");
    const html = await (await fetch(ORIGIN, { headers: { cookie: "sb_desktop=1" } })).text();
    assert.ok(!html.includes("Know the moment"), "the server sent the app the landing page");
    // The server is chosen here, as on the web, in the app's own window (#1449).
    await page.getByRole("button", { name: "Use your own server" }).click();
    await until(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.getTitle() === "Server"),
        ),
      "the server window",
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Server")
        ?.close(),
    );
    await page.getByText("Opens your browser.").waitFor();

    step("sign in with GitHub (stub) through the browser, and set up the app as the first device");
    // Clicked with the mouse, which the app requires to open the browser (#1721): Playwright's
    // click would wait for a navigation the app cancels.
    const box = await page
      .getByRole("link", { name: /^(Sign in|Continue) with GitHub$/ })
      .boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // The app sends the sign-in to the browser; this run plays the browser, following redirects
    // through GitHub and the server until the starbridge://auth link the browser would open.
    const next = await until(
      async () => (await main((g) => g.outside)).find((u) => u.includes("/v1/auth/github?app=1")),
      "the sign-in sent to the browser",
    );
    // The browser keeps the server's cookie from the start to the callback, which binds the
    // sign-in's return to it.
    const back = await followSignIn(next);
    assert.ok(back.at.startsWith("starbridge:"), `${back.at} answered ${back.status}`);
    await app.evaluate(({ app }, link) => {
      app.emit("open-url", { preventDefault() {} }, link);
    }, back.at);
    await page.getByText("This app creates your account's keys.").waitFor();
    await shoot(app, page, "keys");
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
    await shoot(app, page, "inbox-empty");
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
    await shoot(app, page, "pairing");
    assert.equal(
      await cli("confirm", ["pair", "--confirm"], machine).exited,
      0,
      "pair --confirm failed",
    );
    await pair.waitFor(/✓ Paired as devbox/);
    assert.equal(await pair.exited, 0, "pair failed");
    await page.getByRole("link", { name: /^Inbox/ }).click();

    step(
      "switching tabs waits on nothing: no request for the page, the median switch painted within 100 ms",
    );
    // The tabs prefetch their pages once they show (web: Shell.tsx); Quotas shows with quotas.
    const prefetched = page.waitForResponse((r) => /\/quotas\?_rsc=/.test(r.url()));
    const quota = cli(
      "quota",
      ["quota", "push", "--once", "--codexbar", join(ROOT, "cli/test/fixtures/fake-codexbar.sh")],
      machine,
    );
    assert.equal(await quota.exited, 0, "quota push failed");
    const rail = page.getByRole("navigation", { name: "Main" }).first();
    await rail.getByRole("link", { name: "Quotas" }).waitFor();
    await prefetched;
    // The first round is cold and only logged. In every warm one, no switch may fetch its page:
    // that is what makes it instant. Timing is checked on each tab's median switch.
    const tabs = [
      ["Quotas", "Quotas"],
      ["Settings", "Settings"],
      ["Inbox", "Inbox"],
    ] as const;
    const times = new Map<string, number[]>(tabs.map(([tab]) => [tab, []]));
    for (let round = 0; round <= WARM_SWITCHES; round++) {
      for (const [tab, heading] of tabs) {
        const fetched: string[] = [];
        const onRequest = (r: { url(): string }) => {
          if (!r.url().includes("/v1/")) fetched.push(r.url());
        };
        page.on("request", onRequest);
        const ms = await page.evaluate(switchTab, [tab, heading] as const);
        page.off("request", onRequest);
        console.log(`${round ? "warm" : "cold"} ${tab}: ${Math.round(ms)} ms ${fetched.join(" ")}`);
        if (!round) continue;
        assert.deepEqual(fetched, [], `switching to ${tab} fetched the page`);
        times.get(tab)?.push(ms);
      }
    }
    for (const [tab, ms] of times) {
      const median = [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? Infinity;
      assert.ok(
        median < SWITCH_MS,
        `switching to ${tab} took ${Math.round(median)} ms (median of ${ms.map(Math.round).join(", ")})`,
      );
    }

    await page.evaluate(switchTab, ["Quotas", "Quotas"] as const);
    await shoot(app, page, "quotas");

    step("the app menu's Find… focuses the page's Find box, and Settings… opens Settings (#1857)");
    await page.evaluate(switchTab, ["Inbox", "Inbox"] as const);
    const clickMenu = (label: string) =>
      app.evaluate(({ Menu }, name) => {
        const walk = (menu: Electron.Menu | null | undefined): Electron.MenuItem | undefined => {
          for (const item of menu?.items ?? []) {
            if (item.label === name) return item;
            const inner = walk(item.submenu);
            if (inner) return inner;
          }
        };
        const item = walk(Menu.getApplicationMenu());
        if (!item) throw new Error(`no menu item ${name}`);
        item.click();
      }, label);
    await clickMenu("Find…");
    await until(
      () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Find"),
      "the Find box focused by Find…",
    );
    await clickMenu("Settings…");
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    await page.evaluate(switchTab, ["Quotas", "Quotas"] as const);

    step("a page load on Settings shows every tab from its first frame, as after a deploy");
    // A window open across a deploy loads in full on its next switch that reaches the server; the
    // Quotas tab hid until the quotas arrived (#1805).
    await page.addInitScript(() => {
      const frames: string[] = [];
      Object.assign(window, { navFrames: frames });
      const t0 = performance.now();
      const record = () => {
        const nav = document.querySelector('nav[aria-label="Main"]');
        if (nav)
          frames.push(
            [...nav.querySelectorAll("ul a")].map((a) => a.textContent?.match(/^\D+/)?.[0]).join(),
          );
        if (performance.now() - t0 < 3000) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    await page.goto(`${ORIGIN}/settings`);
    await page.getByRole("heading", { name: "Notifications" }).waitFor();
    await new Promise((r) => setTimeout(r, 3000));
    await shoot(app, page, "settings");
    // The Version row (#1892): the app's own version, at the end of Account.
    const versionRow = page.getByRole("button", { name: /^Version / });
    await versionRow.scrollIntoViewIfNeeded();
    assert.match(await versionRow.innerText(), /\d+\.\d+\.\d+/);
    await shoot(app, page, "settings-version");
    const frames = await page.evaluate(
      () => (window as unknown as { navFrames: string[] }).navFrames,
    );
    assert.ok(frames.length > 0, "no frame showed the tabs");
    assert.deepEqual(
      [...new Set(frames)],
      ["Inbox,Quotas,Settings"],
      "a frame of the load missed a tab",
    );
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
    await until(() => main((g) => g.tips.at(-1) === "Starbridge: 1 needs you"), "the amber dot");
    await page.getByText("Ship the desktop app?", { exact: true }).first().waitFor();
    await shoot(app, page, "inbox-question");
    // While the window is hidden, as when closed to the menu bar.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    await main((g) => {
      const n = g.shown.find((n) => n.title === "Ship the desktop app?");
      n?.emit("action", { actionIndex: 1 }, 1);
    });
    await first.waitFor(/Answer to d_\S+ \(Ship the desktop app\?\): Wait/);
    assert.equal(await first.exited, 0);
    await until(() => main((g) => g.tips.at(-1) === "Starbridge"), "the dot back to one colour");

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

    step("a pasted reply stops at the server's 4000 characters and is sent (#1921)");
    const fourth = ask("Paste the build log?", "--option", "Paste", "--option", "Skip");
    await page.getByText("Paste the build log?", { exact: true }).first().click();
    const reply = page.getByRole("textbox", { name: "Your answer" });
    await reply.click();
    // Emoji count one each, as the server and the phone apps count them.
    await page.keyboard.insertText("😀".repeat(4001));
    assert.equal(Array.from(await reply.inputValue()).length, 4000);
    await shoot(app, page, "reply-capped");
    await reply.press("Enter");
    await fourth.waitFor(/Answer to d_\S+ \(Paste the build log\?\): 😀/);
    assert.equal(await fourth.exited, 0);

    assert.ok(
      headers.length > 0 && headers.every((h) => h === `desktop/${VERSION}`),
      `the page names itself desktop/${VERSION}: ${[...new Set(headers)].join(", ")}`,
    );
    manifest();
    console.log("\ndesktop stack test passed");
  } catch (e) {
    manifest(e);
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
  shutdown();
}
