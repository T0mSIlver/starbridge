// End-to-end run on one machine: the real server, the built web page, the real CLI, Firefox
// through Playwright, and the stand-ins in services.ts for GitHub and the Web Push service.
//
//   xvfb-run -a node web/e2e/run.ts      (Node 22.6+ runs this TypeScript as is)
//
// Needs `npx playwright install firefox` once. Writes screenshots to web/screenshots.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, firefox, type Page } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const WEB = join(ROOT, "web");
const PORTS = { web: 3870, server: 3871, github: 3872, push: 3873 };
const ORIGIN = `http://localhost:${PORTS.web}`;
const SHOTS = join(WEB, "screenshots");
// Set to a folder to record the inbox's motion there, as one GIF per motion (needs ffmpeg).
const MOTION_VIDEO = process.env.MOTION_VIDEO;
const DESKTOP = { width: 1280, height: 860 };
const tmp = mkdtempSync(join(tmpdir(), "starbridge-e2e-"));
const children: ChildProcess[] = [];

/** Two PNGs to attach to a decision: the sample data's pair of landing heroes (lib/sample.ts). */
function image(which: "a" | "b"): string {
  const shots = JSON.parse(readFileSync(join(WEB, "src/lib/sample-shots.json"), "utf8"));
  const path = join(tmp, `hero-${which}.png`);
  writeFileSync(path, Buffer.from(shots[which.toUpperCase()], "base64url"));
  return path;
}

function step(text: string) {
  console.log(`\n== ${text}`);
}

/** Starts a process and collects its output; `waitFor` resolves on a matching line. */
function start(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: object } = {},
) {
  const p = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(p);
  let out = "";
  const waiters: { re: RegExp; done: (m: RegExpMatchArray) => void }[] = [];
  const feed = (chunk: Buffer) => {
    const text = chunk.toString();
    out += text;
    for (const line of text.split("\n")) if (line.trim()) console.log(`[${name}] ${line}`);
    for (const w of [...waiters]) {
      const m = out.match(w.re);
      if (m) {
        waiters.splice(waiters.indexOf(w), 1);
        w.done(m);
      }
    }
  };
  p.stdout?.on("data", feed);
  p.stderr?.on("data", feed);
  const exited = new Promise<number>((r) => p.on("exit", (code) => r(code ?? -1)));
  return {
    proc: p,
    exited,
    output: () => out,
    waitFor(re: RegExp, ms = 30_000): Promise<RegExpMatchArray> {
      const m = out.match(re);
      if (m) return Promise.resolve(m);
      return new Promise((done, fail) => {
        const t = setTimeout(() => fail(new Error(`${name}: no ${re} within ${ms} ms`)), ms);
        waiters.push({
          re,
          done: (x) => {
            clearTimeout(t);
            done(x);
          },
        });
      });
    },
  };
}

function cli(name: string, args: string[], home: string) {
  return start(name, "bun", ["run", join(ROOT, "cli/src/main.ts"), ...args], {
    env: { STARBRIDGE_CONFIG_DIR: home, STARBRIDGE_SERVER: `http://localhost:${PORTS.server}` },
  });
}

const vapid = JSON.parse(
  spawnSync("bun", ["-e", "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"], {
    cwd: join(ROOT, "server"),
    encoding: "utf8",
  }).stdout,
) as { publicKey: string; privateKey: string };

async function browser() {
  // Headless Firefox has no notification backend, so this runs headed (under xvfb-run on a
  // server) with Firefox's own notification popups instead of the desktop's.
  return firefox.launch({
    headless: false,
    firefoxUserPrefs: {
      "alerts.useSystemBackend": false,
      "dom.push.enabled": true,
      "dom.push.connection.enabled": true,
      "dom.push.serverURL": `ws://localhost:${PORTS.push}/`,
      "dom.push.testing.allowInsecureServerURL": true,
      "permissions.default.desktop-notification": 1,
    },
  });
}

/** The landing page's link, or the sign-in screen's. */
const SIGN_IN = /^(Sign in|Continue) with GitHub$/;

async function signIn(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[page] ${m.text()}`));
  await page.goto(ORIGIN);
  await page.getByRole("link", { name: SIGN_IN }).click();
  return page;
}

const NOTIFICATIONS = () =>
  navigator.serviceWorker.ready.then((r) =>
    r
      .getNotifications()
      .then((ns) => ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag }))),
  );

/** #199: phishing filters flag a new site that asks for seed words. */
async function noWordsAsked(page: Page) {
  const text = await page.locator("body").innerText();
  const found = text.match(/\b(seed|phrase|words?)\b/i);
  if (found) throw new Error(`the page says "${found[0]}"`);
}

async function shoot(page: Page, name: string) {
  for (const [size, viewport] of [
    ["phone", { width: 390, height: 844 }],
    ["desktop", { width: 1280, height: 860 }],
  ] as const)
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(150);
      // Firefox draws the phone layout's fixed bottom bar mid-page in a full-page capture.
      await page.screenshot({
        path: join(SHOTS, `${name}-${size}-${scheme}.png`),
        fullPage: size === "desktop",
      });
    }
}

let failPage: Page | undefined;

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  step("services, server, web");
  const services = start("services", "bun", [join(WEB, "e2e/services.ts")], {
    env: { GITHUB_PORT: PORTS.github, PUSH_PORT: PORTS.push },
  });
  await services.waitFor(/"event":"ready"/);
  const server = start("server", "bun", ["run", "server/src/main.ts"], {
    env: {
      PORT: PORTS.server,
      DB_PATH: join(tmp, "starbridge.db"),
      PUBLIC_URL: ORIGIN,
      GITHUB_CLIENT_ID: "stub",
      GITHUB_CLIENT_SECRET: "stub",
      GITHUB_AUTHORIZE_URL: `http://localhost:${PORTS.github}/login/oauth/authorize`,
      GITHUB_TOKEN_URL: `http://localhost:${PORTS.github}/login/oauth/access_token`,
      GITHUB_API_URL: `http://localhost:${PORTS.github}`,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:e2e@starbridge.invalid",
      ALLOW_PRIVATE_PUSH_ENDPOINTS: "1",
    },
  });
  await server.waitFor(/starbridge server on port/);
  const env = { STARBRIDGE_SERVER: `http://localhost:${PORTS.server}` };
  if (
    spawnSync("bun", ["run", "build"], {
      cwd: WEB,
      env: { ...process.env, ...env },
      stdio: "inherit",
    }).status
  )
    throw new Error("web build failed");
  // The standalone server, laid out as web/Dockerfile copies it.
  const standalone = join(WEB, ".next/standalone/web");
  cpSync(join(WEB, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  cpSync(join(WEB, "public"), join(standalone, "public"), { recursive: true });
  const web = start("web", "node", [join(standalone, "server.js")], {
    env: { ...env, PORT: String(PORTS.web), HOSTNAME: "127.0.0.1" },
  });
  await web.waitFor(/Ready|started server/i);

  const ff = await browser();
  const a = await ff.newContext({
    permissions: ["notifications"],
    ...(MOTION_VIDEO ? { recordVideo: { dir: join(tmp, "video"), size: DESKTOP } } : {}),
  });

  step("a browser with no device lands on the landing page");
  const visitor = await a.newPage();
  await visitor.goto(ORIGIN);
  await visitor.getByRole("heading", { name: /Your agents ask/ }).waitFor();
  await shoot(visitor, "landing");
  for (const [path, name] of [
    ["/privacy", "privacy"],
    ["/terms", "terms"],
    ["/no-such-page", "not-found"],
  ]) {
    await visitor.goto(ORIGIN + path);
    await shoot(visitor, name);
  }
  await visitor.close();

  step("sign in with GitHub (stub) and set up the first device");
  const page = await signIn(a);
  failPage = page;
  await page.getByRole("button", { name: "Create the keys" }).click();
  await page.getByRole("heading", { name: "Save your recovery key" }).waitFor();
  const key = ((await page.getByTestId("recovery-key").textContent()) ?? "").trim();
  if (!/^([0-9A-Z]{4}){7}$/.test(key)) throw new Error(`expected a recovery key, got: ${key}`);
  await noWordsAsked(page);
  await shoot(page, "setup");
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByLabel(/I wrote this key down/).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Inbox" }).waitFor();

  step("turn on Web Push");
  await page.getByRole("button", { name: "Turn on notifications" }).click();
  await services.waitFor(/"event":"subscribed"/);
  await page.getByRole("button", { name: "Turn on notifications" }).waitFor({ state: "detached" });

  step("approve `starbridge pair` from the Devices page");
  const machineHome = join(tmp, "machine");
  const pair = cli("pair", ["pair", "--name", "devbox"], machineHome);
  const code = (await pair.waitFor(/Pairing code: (\S+)/))[1] as string;
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("link", { name: "Add a device" }).click();
  await page.getByLabel("Pair a machine or device").fill(code);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await pair.waitFor(/Paired "devbox"/);
  if ((await pair.exited) !== 0) throw new Error("pair failed");
  await page.getByRole("status", { name: "Pairing result" }).getByText("devbox joined").waitFor();
  await shoot(page, "pair-joined");

  step("refuse a second pairing");
  const other = cli("pair-refused", ["pair", "--name", "stranger"], join(tmp, "stranger"));
  const code2 = (await other.waitFor(/Pairing code: (\S+)/))[1] as string;
  await page.getByLabel("Pair a machine or device").fill(code2);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByText("Let stranger post decisions and quotas?").waitFor();
  await page.getByRole("button", { name: "Refuse" }).click();
  await page.getByText(/Refused stranger/).waitFor();
  other.proc.kill();

  step("upload a quota snapshot");
  const real = spawnSync("codexbar", ["--version"], { encoding: "utf8" }).status === 0;
  const quota = cli(
    "quota",
    [
      "quota",
      "push",
      "--once",
      ...(real ? [] : ["--codexbar", join(ROOT, "cli/test/fixtures/fake-codexbar.sh")]),
      ...["claude", "codex", "zai", "mistral"].flatMap((p) => ["--provider", p]),
    ],
    machineHome,
  );
  if ((await quota.exited) !== 0) throw new Error("quota push failed");

  step("answer `starbridge ask --wait` from the inbox, with a Web Push for it");
  await page.getByRole("link", { name: "Inbox" }).click();
  const pushesBefore = (services.output().match(/"event":"push"/g) ?? []).length;
  const ask = cli(
    "ask",
    [
      "ask",
      "--question",
      "Run the migration on the staging database now?",
      "--context",
      "The schema change adds a NOT NULL column with a default.\n```sql\nALTER TABLE items ADD COLUMN answered_by TEXT NOT NULL DEFAULT '';\n```\nIt locks `items` for about 2 s.",
      "--option",
      "Run it",
      "--option",
      "Wait for tonight",
      "--default",
      "Wait for tonight",
      "--default-at",
      "2h",
      "--project",
      "starbridge",
      "--session",
      "e2e",
      "--wait",
    ],
    machineHome,
  );
  await ask.waitFor(/^d_\S+$/m);
  const pushes = () => (services.output().match(/"event":"push"/g) ?? []).length;
  for (let i = 0; i < 150 && pushes() <= pushesBefore; i++) await page.waitForTimeout(200);
  if (pushes() <= pushesBefore) throw new Error("the server sent no Web Push for the decision");
  const shown = async () =>
    (await page.evaluate(NOTIFICATIONS)) as { title: string; body: string }[];
  for (
    let i = 0;
    i < 50 && !(await shown()).some((n) => n.title.startsWith("Run the migration"));
    i++
  )
    await page.waitForTimeout(200);
  const notifications = await shown();
  console.log("notifications:", JSON.stringify(notifications));
  if (!notifications.some((n) => n.title === "Run the migration on the staging database now?"))
    throw new Error("no Web Push notification for the decision");
  // With History open the answered question stays listed, which is where it lingered (#214).
  await page.getByRole("button", { name: /History/ }).click();
  await page.getByRole("button", { name: /Run it/ }).click();
  await ask.waitFor(/Answer to d_\S+ \(Run the migration on the staging database now\?\): Run it/);
  if ((await ask.exited) !== 0) throw new Error("ask --wait failed");
  // The answered push closes the decision's notification.
  for (
    let i = 0;
    i < 50 && (await shown()).some((n) => n.title.startsWith("Run the migration"));
    i++
  )
    await page.waitForTimeout(200);

  // It was the last open question, so the detail pane empties rather than showing it answered.
  await page
    .locator('section[aria-label="Selected"] h2')
    .waitFor({ state: "detached", timeout: 10_000 });
  await shoot(page, "inbox-cleared");
  await page.getByRole("button", { name: /History/ }).click();

  step("leave one open decision for the screenshots");
  const open = cli(
    "ask-open",
    [
      "ask",
      "--question",
      "Merge #19 (server) before the web PR rebases?",
      "--context",
      "CI is green on #19 and both vendors reviewed it. Merging first lets #8 rebase onto main.\n```\ngh pr merge 19 --squash\n```",
      "--option",
      "Merge now",
      "--option",
      "Hold",
      "--default",
      "Hold until the owner is back",
      "--project",
      "starbridge",
      "--session",
      "3f2a9c1e-5b7d-4e8a-9c0f-1d2e3f4a5b6c",
      "--session-title",
      "Merge the server PR (#19)",
      "--session-link",
      "remote-control=https://claude.ai/code/session_01UZCLSHk7GjaUdtNBsLAvvt",
      "--session-link",
      "desktop=claude://claude.ai/epitaxy/local_dbf54d69-f2ac-4a14-b298-d7bb6ecf0e3f",
      "--image",
      image("a"),
      "--image",
      image("b"),
      "--link",
      "https://claude.ai/public/artifacts/0b3f0e7c",
    ],
    machineHome,
  );
  await open.exited;
  // At desktop width the question shows in the list and in the detail pane.
  await page
    .getByText("Merge #19 (server) before the web PR rebases?")
    .first()
    .waitFor({ timeout: 30_000 });
  await shoot(page, "inbox");
  const opener = page
    .locator('section[aria-label="Selected"]')
    .getByRole("link", { name: "Open in Claude" });
  if (
    (await opener.getAttribute("href")) !==
    "https://claude.ai/code/session_01UZCLSHk7GjaUdtNBsLAvvt"
  )
    throw new Error("the open decision has no Open in Claude link to its Remote Control session");
  await page.getByText("Merge the server PR (#19)").first().waitFor();
  const pane = page.locator('section[aria-label="Selected"]');
  const widths = await pane
    .locator("img")
    .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth));
  if (widths.length !== 2 || widths.some((w) => w === 0))
    throw new Error(`the open decision shows ${widths.length} images, widths ${widths}`);
  if (
    (await pane.getByRole("link", { name: "Claude artifact" }).getAttribute("href")) !==
    "https://claude.ai/public/artifacts/0b3f0e7c"
  )
    throw new Error("the open decision has no chip for its Claude artifact");

  // Desktop: one selection, whether picked by click or by J and K; focus follows it in the list.
  const row = page.locator('[aria-current="true"]:has(button[data-id])');
  const detail = page.locator('section[aria-label="Selected"] h2');
  await page.locator("button[data-id]").first().click();
  for (const key of ["j", "j", "k"]) {
    await page.keyboard.press(key);
    const question = await detail.innerText();
    if (!(await row.innerText()).includes(question))
      throw new Error(
        `after ${key}, the list selects "${await row.innerText()}" but the detail shows "${question}"`,
      );
    if (!(await row.evaluate((el) => el.contains(document.activeElement))))
      throw new Error(`after ${key}, focus is not on the selected row`);
  }
  step("inbox motion: an arrival, a flip to waiting, an answer, History, a phone's detail");
  {
    const m = await a.newPage();
    const start = Date.now();
    const marks: [string, number, number][] = [];
    const mark = async (name: string, f: () => Promise<unknown>, ms: number) => {
      const at = Date.now() - start;
      await f();
      await m.waitForTimeout(ms);
      marks.push([name, at, Date.now() - start - at]);
    };
    await m.setViewportSize(DESKTOP);
    await m.goto(ORIGIN);
    await m.getByText("Merge #19 (server) before the web PR rebases?").first().waitFor();
    await m.waitForTimeout(2000);
    const QUESTION = "Bump the lockfile before the release branch?";
    let id = "";
    await mark(
      "arrive",
      async () => {
        const ask = cli(
          "ask-motion",
          [
            "ask",
            "--question",
            QUESTION,
            "--option",
            "Bump it",
            "--option",
            "Leave it",
            "--project",
            "starbridge",
            "--session",
            "motion",
          ],
          machineHome,
        );
        id = (await ask.waitFor(/^d_\S+$/m))[0];
        await m.locator(`[data-row="${id}"]`).waitFor({ timeout: 30_000 });
      },
      1200,
    );
    await mark(
      "flip",
      async () => {
        if ((await cli("waiting", ["waiting", id], machineHome).exited) !== 0)
          throw new Error("starbridge waiting failed");
        await m.getByRole("button", { name: /^Waiting for you.*Bump the lockfile/ }).waitFor();
      },
      1200,
    );
    await m.locator(`button[data-id="${id}"]`).click();
    await m.waitForTimeout(600);
    await mark(
      "leave",
      async () => {
        await m
          .locator('section[aria-label="Selected"]')
          .getByRole("button", { name: /Bump it/ })
          .click();
        await m.locator(`[data-row="${id}"]`).waitFor({ state: "detached" });
      },
      1000,
    );
    // The answered row fades out, then nothing of it is left to select or read.
    if ((await m.locator(`button[data-id="${id}"]`).count()) > 0)
      throw new Error("the answered row is still selectable");
    await mark("history", () => m.getByRole("button", { name: /History/ }).click(), 1000);
    await mark("history", () => m.getByRole("button", { name: /History/ }).click(), 800);
    await m.setViewportSize({ width: 390, height: 844 });
    await m.waitForTimeout(800);
    await mark("phone-detail", () => m.locator("button[data-id]").first().click(), 1000);
    await mark("phone-detail", () => m.getByRole("button", { name: /Back/ }).click(), 800);
    const video = m.video();
    await m.close();
    if (MOTION_VIDEO && video) {
      mkdirSync(MOTION_VIDEO, { recursive: true });
      const webm = await video.path();
      cpSync(webm, join(MOTION_VIDEO, "inbox.webm"));
      const by = new Map<string, [number, number]>();
      for (const [name, at, ms] of marks) {
        const was = by.get(name);
        by.set(name, was ? [was[0], at + ms - was[0]] : [at, ms]);
      }
      for (const [name, [at, ms]] of by) {
        // The headed window paints 720 px; desktop GIFs keep the rail, the list and the detail's edge.
        const crop = name.startsWith("phone") ? "crop=390:720:0:0" : "crop=900:480:0:0";
        const r = spawnSync("ffmpeg", [
          "-y",
          "-loglevel",
          "error",
          "-ss",
          String(Math.max(0, at - 300) / 1000),
          "-t",
          String((ms + 300) / 1000),
          "-i",
          webm,
          "-vf",
          `${crop},fps=25,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
          join(MOTION_VIDEO, `${name}.gif`),
        ]);
        if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr}`);
      }
    }
  }

  step("a decision answered in an artifact links it, and `starbridge settle` closes it");
  const artifact = "https://claude.ai/artifact/2ig2MyNRD484b7oZea5vkZ";
  const pointer = cli(
    "pointer",
    [
      ...["ask", "--question", "Which of the three settings layouts should ship?"],
      ...[
        "--context",
        "Each layout is live in the artifact. Its buttons send your pick to the session.",
      ],
      ...["--answer-in", artifact, "--default", "Ship the roomy layout"],
      ...["--project", "starbridge", "--session-title", "Settings screen (#88)"],
    ],
    machineHome,
  );
  const [pointerId] = await pointer.waitFor(/d_[\w-]+/);
  if ((await pointer.exited) !== 0) throw new Error("ask --answer-in failed");
  const pointerRow = page.locator(`button[data-id="${pointerId}"]`);
  await pointerRow.waitFor({ timeout: 30_000 });
  await pointerRow.click();
  const answerIn = pane.getByRole("link", { name: "Answer in the artifact" });
  if ((await answerIn.getAttribute("href")) !== artifact)
    throw new Error("the decision does not link the artifact it is answered in");
  if ((await pane.locator("fieldset, textarea").count()) > 0)
    throw new Error("a decision answered in an artifact also offers an answer here");
  await shoot(page, "answer-in");
  const settle = cli("settle", ["settle", pointerId as string], machineHome);
  if ((await settle.exited) !== 0) throw new Error("settle failed");
  // The settled notice arrives by Web Push, the page reloads the inbox, and History lists it.
  await pointerRow.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByRole("button", { name: /History/ }).click();
  await page
    .locator(`[data-id="${pointerId}"]`)
    .locator("..")
    .getByText(/Answered in the artifact/)
    .waitFor();

  await page.getByRole("link", { name: "Quotas" }).click();
  await page.locator("article").first().waitFor();
  await shoot(page, "quotas");

  step("quota settings: remaining, clock times, workdays");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  // Each radio hides inside its segment, which takes the click.
  for (const label of ["Left", "Resets 14:20", "5", "High contrast"])
    await page.getByLabel(label, { exact: true }).check({ force: true });
  await shoot(page, "settings");
  await page.getByRole("link", { name: "Quotas" }).click();
  await page.locator("article").first().waitFor();
  if (!(await page.locator("article").first().innerText()).includes("% left"))
    throw new Error("the bars do not show what is left");
  await shoot(page, "quotas-tuned");

  step("quota settings: the order set holds over running out first");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("switch", { name: "Running out first" }).uncheck();
  await page.getByRole("link", { name: "Quotas" }).click();
  await page.locator("article").first().waitFor();
  await shoot(page, "quotas-your-order");

  step("clock setting: 24-hour times in a browser whose language uses 12-hour");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByLabel("24-hour", { exact: true }).check({ force: true });
  await shoot(page, "settings-clock");
  await page.getByRole("link", { name: "Quotas" }).click();
  await page.locator("article").first().waitFor();
  if (/\b[AP]M\b/.test(await page.locator("main").innerText()))
    throw new Error("the 24-hour setting still shows AM or PM");
  await shoot(page, "quotas-24h");

  step("the inbox's quota aside fits its column with clock times on (#168)");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  // 12-hour times are the longest: "Will run out at Oct 12, 12:02 AM".
  await page.getByLabel("12-hour", { exact: true }).check({ force: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "Inbox" }).click();
  const aside = page.getByRole("complementary", { name: "Quota windows" });
  await aside.locator("article").first().waitFor();
  const { scroll, client } = await aside.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  if (scroll > client) throw new Error(`the quota aside overflows: ${scroll} > ${client} px`);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `inbox-aside-wide-${scheme}.png`) });
  }

  step("a newly raised quota alert notifies a browser that opted in to its provider");
  // A 5-hour window at 85%, 3 hours in: "low" at 20% left, and it runs out before the reset.
  const at = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, "Z");
  const usage = [
    {
      provider: "e2e",
      source: "api",
      usage: {
        updatedAt: at(0),
        primary: { windowMinutes: 300, usedPercent: 85, resetsAt: at(2 * 3600_000) },
      },
    },
  ];
  const fakeBar = join(tmp, "codexbar-e2e.sh");
  writeFileSync(fakeBar, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(usage)}\nEOF\n`, {
    mode: 0o755,
  });
  const alertPush = cli(
    "quota-alert",
    ["quota", "push", "--once", "--codexbar", fakeBar, "--provider", "e2e"],
    machineHome,
  );
  if ((await alertPush.exited) !== 0) throw new Error("quota push failed");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByLabel("Notify about e2e").check();
  await page.getByRole("link", { name: "Quotas" }).click();
  await page.waitForFunction(
    () =>
      navigator.serviceWorker.ready
        .then((r) => r.getNotifications())
        .then((ns) => ns.some((n) => n.title === "e2e 5-hour: 20% left")),
    undefined,
    { timeout: 30_000 },
  );
  // The next snapshot lists the same alerts without notify: nothing shows again.
  const again = cli(
    "quota-again",
    ["quota", "push", "--once", "--codexbar", fakeBar, "--provider", "e2e"],
    machineHome,
  );
  if ((await again.exited) !== 0) throw new Error("quota push failed");
  if (again.output().includes("(new)"))
    throw new Error("the second snapshot raised its alerts again");

  step("add a second browser by pairing code");
  const b = await ff.newContext();
  const pageB = await signIn(b);
  await pageB.getByTestId("pairing-code").waitFor({ timeout: 10_000 });
  await shoot(pageB, "join-browser");
  // Switching to digits cancels the QR code's wait; that cancel shows no error.
  await pageB.getByRole("button", { name: "Can't scan? Compare digits" }).click();
  await pageB.getByText(/Open Starbridge on a signed-in device/).waitFor();
  await pageB.waitForTimeout(1000);
  // Next.js's route announcer is an empty alert too; the page's errors are paragraphs.
  const digitsError = pageB.locator('p[role="alert"]');
  if (await digitsError.count())
    throw new Error(`digits show an error: ${await digitsError.textContent()}`);
  await shoot(pageB, "join-digits");
  // The signed-in browser gets the join request as a panel over the page; refusing ends it in a
  // result that clears itself.
  const joinAsk = page.getByTestId("join-request");
  await joinAsk.waitFor({ timeout: 30_000 });
  await shoot(page, "join-request");
  await joinAsk.getByRole("button", { name: "Refuse" }).click();
  const result = page.getByRole("status", { name: "Pairing result" });
  await result.waitFor();
  await result.waitFor({ state: "detached", timeout: 15_000 });
  await pageB.getByRole("button", { name: "Cancel" }).click();
  const codeB = (
    await pageB
      .getByTestId("pairing-code")
      .filter({ hasText: /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/ })
      .textContent({ timeout: 10_000 })
  )?.trim();
  if (!codeB) throw new Error("no pairing code on the second browser");
  await shoot(pageB, "join");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("link", { name: "Add a device" }).click();
  await page.getByLabel("Pair a machine or device").fill(codeB);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByText(/read and answer as a device/).waitFor();
  await page.getByRole("button", { name: "Approve" }).click();
  await pageB.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  await pageB.getByRole("button", { name: "Turn on notifications" }).waitFor();
  await shoot(pageB, "inbox-banner");
  // The new device sees decisions sealed after it joined; the open one predates it.

  step("recover a third browser with the recovery key");
  const c = await ff.newContext();
  const pageC = await signIn(c);
  await pageC.getByRole("button", { name: "Use the recovery key" }).click();
  const entry = pageC.getByLabel("Your recovery key");
  await noWordsAsked(pageC);
  await entry.fill(`${key.slice(0, 9)}U`);
  await pageC.getByText('Character 10, "U", is not in a recovery key.').waitFor();
  await shoot(pageC, "recovery-typo");
  // Lower case, in groups split by spaces: the key reads all the same.
  await entry.fill(key.toLowerCase().match(/.{4}/g)?.join(" ") ?? "");
  await pageC.getByText("28 of 28 characters").waitFor();
  await pageC.getByRole("button", { name: "Recover" }).click();
  await pageC.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });

  step("revoke the second browser");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  const devices = page.getByRole("region", { name: "Devices" });
  await devices.getByText("Device · this browser").waitFor();
  // Devices list this browser, then the others by when they joined: the second browser first.
  // The list may still gain the recovered browser, so the second browser's sign-out below,
  // not a count, proves the revocation.
  await devices.getByRole("button", { name: "Revoke" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await pageB.reload();
  // A browser whose device was revoked is a visitor again: the landing page, not sign-in.
  await pageB.getByRole("heading", { name: /Your agents ask/ }).waitFor();
  await page.emulateMedia({ colorScheme: "light" });
  await shoot(page, "devices");

  step("a pairing link opened while signed out keeps its code through GitHub sign-in");
  const linked = cli("pair-link", ["pair", "--name", "laptop"], join(tmp, "laptop"));
  const code3 = (await linked.waitFor(/Pairing code: (\S+)/))[1] as string;
  await a.clearCookies();
  await page.goto(`${ORIGIN}/pair#${code3}`);
  await page.getByRole("link", { name: SIGN_IN }).click();
  await page.getByText("Let laptop post decisions and quotas?").waitFor({ timeout: 30_000 });
  await shoot(page, "pair-request");
  await page.getByRole("button", { name: "Approve" }).click();
  await linked.waitFor(/Paired "laptop"/);
  if ((await linked.exited) !== 0) throw new Error("pair by link failed");

  step("sign in again: the session binds to the existing device without pairing");
  await a.clearCookies();
  await page.goto(ORIGIN);
  await page.getByRole("heading", { name: "Sign in to Starbridge" }).waitFor();
  await shoot(page, "sign-in");
  await page.getByRole("link", { name: SIGN_IN }).click();
  await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  await page.getByText("Merge #19 (server) before the web PR rebases?").first().waitFor();

  await page.goto(`${ORIGIN}/settings/devices/add`);
  await page.getByTestId("shown-code").waitFor();
  await shoot(page, "add-device");

  await ff.close();
  console.log("\nE2E PASSED");
}

try {
  await main();
} catch (e) {
  console.error("\nE2E FAILED:", e);
  if (failPage) {
    await failPage
      .screenshot({ path: join(tmpdir(), "starbridge-e2e-failure.png") })
      .catch(() => {});
    console.error(
      (
        await failPage
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 2000),
    );
  }
  process.exitCode = 1;
} finally {
  await failPage
    ?.context()
    .browser()
    ?.close()
    .catch(() => {});
  for (const p of children) p.kill();
  rmSync(tmp, { recursive: true, force: true });
}
