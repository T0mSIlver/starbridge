// Times the switch between the app's pages, Inbox → Quotas → Settings → Inbox, on the whole
// product (the real server, the built web page, a paired machine with quotas), behind a proxy that
// adds starbridge.run's round trip. Each switch is timed from the click to the frame that paints
// the new page, with what went over the network meanwhile and the frames where the page was blank.
//
//   node desktop/test/switch.ts [--client app|chrome] [--app BINARY] [--rtt MS] [--json FILE]
//
// --client chrome runs the same switch in Playwright's Chromium, for the web's numbers.
// (After `pnpm --filter @starbridge/desktop build`; under xvfb-run on Linux.)
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, _electron as electron, type Page } from "playwright";
import {
  boot,
  buildWeb,
  followSignIn,
  cli as machine,
  PORTS,
  ROOT,
  serveWeb,
  shutdown,
  tmp,
} from "../../web/e2e/stack.ts";
import { freePorts } from "./ports.ts";

const { values: opts } = parseArgs({
  options: {
    client: { type: "string", default: "app" },
    app: { type: "string" },
    rtt: { type: "string", default: "0" },
    json: { type: "string" },
    rounds: { type: "string", default: "3" },
    /** A window already running elsewhere, such as the packaged app on a Mac, by its debugging port. */
    cdp: { type: "string" },
    /** The proxy's port, fixed so a tunnel can reach it (the page's origin is localhost:PORT). */
    port: { type: "string" },
    /** Rebuilds and restarts the web page after the rounds, as a deploy does, then switches again. */
    deploy: { type: "boolean", default: false },
  },
});
const RTT = Number(opts.rtt);
const DESKTOP = join(ROOT, "desktop");

const PROXY = opts.port ? Number(opts.port) : (await freePorts(["proxy"])).proxy;
const ORIGIN = `http://localhost:${PROXY}`;
// Fixed: the built page proxies /v1 to the address it was built with (SKIP_WEB_BUILD).
const SERVER = `http://localhost:47211`;

/** Holds each chunk half the round trip in each direction, in order. */
function latencyProxy(listen: number, to: number, rtt: number) {
  const delay = (from: Socket, into: Socket) => {
    let last = 0;
    from.on("data", (chunk) => {
      const at = Math.max(Date.now() + rtt / 2, last);
      last = at;
      setTimeout(() => into.writable && into.write(chunk), at - Date.now());
    });
    from.on("end", () => setTimeout(() => into.end(), Math.max(0, last - Date.now()) + 1));
    from.on("error", () => into.destroy());
  };
  const s = createServer((client) => {
    const upstream = connect(to, "127.0.0.1");
    delay(client, upstream);
    delay(upstream, client);
  });
  s.listen(listen, "127.0.0.1");
  return s;
}

const cli = (name: string, args: string[], home: string) =>
  machine(name, args, home, { server: SERVER, quiet: true });

async function until<T>(f: () => Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The CodexBar fixtures, moved to this run's clock (web/e2e/run.ts, fakeCodexbar). */
function fakeCodexbar(): string {
  const shift = Date.now() - Date.parse("2026-10-04T19:09:00Z");
  const dir = join(tmp, "codexbar-fixture");
  mkdirSync(join(dir, "codexbar"), { recursive: true });
  const fixtures = join(ROOT, "cli/test/fixtures");
  cpSync(join(fixtures, "fake-codexbar.sh"), join(dir, "fake-codexbar.sh"));
  for (const f of readdirSync(join(fixtures, "codexbar")))
    writeFileSync(
      join(dir, "codexbar", f),
      readFileSync(join(fixtures, "codexbar", f), "utf8").replace(
        /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g,
        (t) => new Date(Date.parse(t) + shift).toISOString().replace(/\.\d+Z$/, "Z"),
      ),
    );
  return join(dir, "fake-codexbar.sh");
}

type Switch = {
  to: string;
  /** Click to the frame painting the new page's heading. */
  ms: number;
  /** Frames between the click and then where the main area showed nothing. */
  blankFrames: number;
  requests: { url: string; ms: number; status: number }[];
  reloaded: boolean;
};

/** Clicks a tab and times it from inside the page, frame by frame. */
async function time(page: Page, tab: string, heading: string): Promise<Switch> {
  const requests: Switch["requests"] = [];
  const t0 = Date.now();
  const onReq = (r: import("playwright").Request) => {
    const started = Date.now();
    r.response().then(
      (res) =>
        requests.push({
          url: r.url().replace(ORIGIN, ""),
          ms: Date.now() - started,
          status: res?.status() ?? 0,
        }),
      () => {},
    );
  };
  page.on("request", onReq);
  let reloaded = false;
  const onNav = (f: import("playwright").Frame) => {
    if (f === page.mainFrame() && Date.now() - t0 > 0) reloaded = true;
  };
  page.on("load", onNav as never);
  const r = await page
    .evaluate(
      ([tab, heading]) =>
        new Promise<{ ms: number; blankFrames: number }>((done) => {
          const nav = document.querySelector('nav[aria-label="Main"]');
          const link = [...(nav?.querySelectorAll("a") ?? [])].find((a) =>
            (a.textContent ?? "").trim().startsWith(tab),
          );
          if (!link) throw new Error(`no ${tab} tab`);
          let blankFrames = 0;
          const t0 = performance.now();
          const shows = () =>
            [...document.querySelectorAll("h1")].some((h) => h.textContent === heading) &&
            (document.querySelector("main")?.textContent ?? "").trim().length > heading.length;
          const tick = () => {
            if (performance.now() - t0 > 10_000) {
              done({
                ms: -1,
                blankFrames,
                stuck: `${location.href}: ${(document.querySelector("main")?.textContent ?? document.body.textContent ?? "").slice(0, 200)}`,
              } as never);
              return;
            }
            if (shows()) {
              // The frame that paints it starts after this one's callbacks.
              requestAnimationFrame(() =>
                setTimeout(() => done({ ms: performance.now() - t0, blankFrames })),
              );
              return;
            }
            if (!(document.querySelector("main")?.textContent ?? "").trim()) blankFrames++;
            requestAnimationFrame(tick);
          };
          link.click();
          requestAnimationFrame(tick);
        }),
      [tab, heading] as const,
    )
    .catch(async () => {
      // A whole-page load replaced the document mid-switch: timed from outside.
      reloaded = true;
      await page.locator("h1", { hasText: heading }).first().waitFor({ state: "attached" });
      await page.waitForFunction(
        (h) => (document.querySelector("main")?.textContent ?? "").trim().length > h.length,
        heading,
      );
      return { ms: Date.now() - t0, blankFrames: -1 };
    });
  await new Promise((r) => setTimeout(r, Math.max(300, RTT * 3)));
  page.off("request", onReq);
  page.off("load", onNav as never);
  return { to: tab, ...r, requests, reloaded };
}

/** Signs in the web's way, outside any window, and returns the session cookie. */
async function webSession(): Promise<string> {
  const { cookies } = await followSignIn(`${ORIGIN}/v1/auth/github`);
  const session = cookies.get(ORIGIN)?.get("sb_session");
  assert.ok(session, "no session cookie from the sign-in");
  return session;
}

try {
  const proxy = latencyProxy(PROXY, PORTS.web, RTT);
  let { web } = await boot({
    origin: ORIGIN,
    serverPort: 47211,
    push: false,
    build: !process.env.SKIP_WEB_BUILD,
    quiet: true,
  });

  let page: Page;
  let close: () => Promise<void>;
  /** Closes the window to the menu bar and opens it again: the app on this machine only. */
  let hide: (() => Promise<unknown>) | null = null;
  let show: (() => Promise<unknown>) | null = null;
  if (opts.cdp) {
    const session = await webSession();
    const browser = await chromium.connectOverCDP(opts.cdp);
    const ctx = browser.contexts()[0];
    assert.ok(ctx, "no browser context over CDP");
    page =
      ctx.pages().find((p) => p.url().startsWith(ORIGIN)) ??
      ctx.pages()[0] ??
      (await ctx.newPage());
    // Through the page's own session: the app's window has its own partition.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.setCookie", { name: "sb_session", value: session, url: ORIGIN });
    await page.goto(ORIGIN);
    close = () => browser.close();
  } else if (opts.client === "chrome") {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addCookies([{ name: "sb_session", value: await webSession(), url: ORIGIN }]);
    page = await ctx.newPage();
    await page.goto(ORIGIN);
    close = () => browser.close();
  } else {
    // A packaged app ignores STARBRIDGE_SERVER (#1721): its server comes from its settings.
    if (opts.app) {
      mkdirSync(join(tmp, "app"), { recursive: true });
      writeFileSync(join(tmp, "app", "settings.json"), JSON.stringify({ server: ORIGIN }));
    }
    const app = await electron.launch({
      ...(opts.app
        ? { executablePath: opts.app, args: [`--user-data-dir=${join(tmp, "app")}`] }
        : { args: [DESKTOP, `--user-data-dir=${join(tmp, "app")}`] }),
      env: { ...process.env, STARBRIDGE_SERVER: ORIGIN },
    });
    await app.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>;
      g.outside = [];
      shell.openExternal = async (u: string) => {
        (g.outside as string[]).push(u);
      };
    });
    page = await app.firstWindow();
    // Clicked with the mouse, which the app requires to open the browser (#1721).
    await page.getByText("Opens your browser.").waitFor();
    const box = await page
      .getByRole("link", { name: /^(Sign in|Continue) with GitHub$/ })
      .boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const next = await until(
      async () =>
        (
          (await app.evaluate(() => (globalThis as unknown as { outside: string[] }).outside)) ?? []
        ).find((u) => u.includes("/v1/auth/github?app=1")),
      "the sign-in sent to the browser",
    );
    // The browser keeps the server's cookie from the start to the callback, which binds the
    // sign-in's return to it.
    const back = await followSignIn(next);
    assert.ok(back.at.startsWith("starbridge:"), `${back.at} answered ${back.status}`);
    await app.evaluate(({ app }, link) => {
      app.emit("open-url", { preventDefault() {} }, link);
    }, back.at);
    close = () => app.close();
    hide = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    show = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
  }
  page.on("console", (m) => m.type() === "error" && console.log(`[page] ${m.text()}`));
  try {
    await page.getByLabel(/I stored this key/).check();
    await page.getByRole("button", { name: "Create the account" }).click();
    await page.getByRole("heading", { name: "Add a machine" }).waitFor();

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
    await pair.waitFor(/Check code: (\S+)/);
    assert.equal(await cli("confirm", ["pair", "--confirm"], machine).exited, 0);
    assert.equal(await pair.exited, 0, "pair failed");
    const quota = cli(
      "quota",
      [
        "quota",
        "push",
        "--once",
        "--codexbar",
        fakeCodexbar(),
        "--provider",
        "claude",
        "--provider",
        "codex",
      ],
      machine,
    );
    assert.equal(await quota.exited, 0, `quota push failed\n${quota.output()}`);
    // Back to the inbox the way the owner gets there, then let the page settle.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: /^Inbox/ })
      .click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Quotas" })
      .waitFor();
    // A fresh start for the first round: a reload, as an app opened in the morning.
    await page.reload();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Quotas" })
      .waitFor();
    await new Promise((r) => setTimeout(r, 2000));

    const rounds: Switch[][] = [];
    for (let i = 0; i < Number(opts.rounds); i++) {
      const round: Switch[] = [];
      for (const [tab, heading] of [
        ["Quotas", "Quotas"],
        ["Settings", "Settings"],
        ["Inbox", "Inbox"],
      ] as const)
        round.push(await time(page, tab, heading));
      rounds.push(round);
      console.log(
        `${opts.client} rtt=${RTT} round ${i + 1}: ${round
          .map(
            (s) =>
              `${s.to} ${Math.round(s.ms)} ms${s.blankFrames ? ` (${s.blankFrames} blank frames)` : ""}${s.reloaded ? " RELOAD" : ""} [${s.requests.map((r) => `${r.url} ${r.status} ${r.ms}ms`).join(", ")}]`,
          )
          .join(" | ")}`,
      );
    }
    if (opts.deploy) {
      web.proc.kill("SIGKILL");
      await web.exited;
      buildWeb(SERVER, true);
      web = await serveWeb(SERVER, true);
      await new Promise((r) => setTimeout(r, 1000));
      if (hide && show) {
        // Closed to the menu bar, the page finds the new build and loads it (web: freshBuild.ts).
        const loaded = page.waitForEvent("load", { timeout: 20_000 }).then(
          () => true,
          () => false,
        );
        await hide();
        console.log(`hidden after deploy: ${(await loaded) ? "reloaded" : "did not reload"}`);
        await show();
        await page
          .getByRole("navigation", { name: "Main" })
          .first()
          .getByRole("link", { name: "Quotas" })
          .waitFor();
        await new Promise((r) => setTimeout(r, 2000));
      }
      for (let i = 0; i < 2; i++) {
        const round: Switch[] = [];
        for (const [tab, heading] of [
          ["Quotas", "Quotas"],
          ["Settings", "Settings"],
          ["Inbox", "Inbox"],
        ] as const)
          round.push(await time(page, tab, heading));
        rounds.push(round);
        console.log(
          `after deploy ${i + 1}: ${JSON.stringify(round.map((s) => [s.to, Math.round(s.ms), s.blankFrames, s.reloaded, s.requests.map((r) => r.url)]))}`,
        );
      }
    }
    if (opts.json)
      writeFileSync(opts.json, JSON.stringify({ client: opts.client, rtt: RTT, rounds }, null, 2));
  } finally {
    // Outside the run's folder, which shutdown deletes.
    await page.screenshot({ path: join(tmpdir(), "starbridge-switch-last.png") }).catch(() => {});
    await close();
    proxy.close();
  }
} finally {
  shutdown();
}
