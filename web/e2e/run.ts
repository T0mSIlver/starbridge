// End-to-end run on one machine: the real server, the built web page, the real CLI, Firefox
// through Playwright, and the stand-ins in services.ts for GitHub and the Web Push service.
//
//   xvfb-run -a node web/e2e/run.ts      (Node 22.6+ runs this TypeScript as is)
//
// Needs `npx playwright install firefox` once. Writes screenshots to web/screenshots.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, firefox, type Page } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const WEB = join(ROOT, "web");
const PORTS = { web: 3870, server: 3871, github: 3872, push: 3873 };
const ORIGIN = `http://localhost:${PORTS.web}`;
const SHOTS = join(WEB, "screenshots");
const tmp = mkdtempSync(join(tmpdir(), "starbridge-e2e-"));
const children: ChildProcess[] = [];

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
  const a = await ff.newContext({ permissions: ["notifications"] });

  step("a browser with no device lands on the landing page");
  const visitor = await a.newPage();
  await visitor.goto(ORIGIN);
  await visitor.getByRole("heading", { name: /Supervise your coding agents/ }).waitFor();
  await shoot(visitor, "landing");
  await visitor.close();

  step("sign in with GitHub (stub) and set up the first device");
  const page = await signIn(a);
  failPage = page;
  await page.getByRole("button", { name: "Create the keys" }).click();
  await page.getByRole("heading", { name: "Save your recovery key" }).waitFor();
  const words = (await page.locator("ol li span:last-child").allTextContents()).join(" ");
  if (words.split(" ").length !== 24) throw new Error(`expected 24 words, got: ${words}`);
  await shoot(page, "setup");
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByLabel(/I wrote these words down/).check();
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
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Add a device" }).click();
  await page.getByLabel("Pair a machine or device").fill(code);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await pair.waitFor(/Paired "devbox"/);
  if ((await pair.exited) !== 0) throw new Error("pair failed");
  await page.getByText("devbox joined.").waitFor();

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
      join(ROOT, "android/app/screenshots/decision-light.png"),
      "--image",
      join(ROOT, "android/app/screenshots/decision-dark.png"),
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
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  for (const label of ["Left", "Resets 14:20", "5", "High contrast"])
    await page.getByLabel(label, { exact: true }).check();
  await shoot(page, "settings");
  await page.getByRole("link", { name: "Quotas" }).click();
  await page.locator("article").first().waitFor();
  if (!(await page.locator("article").first().innerText()).includes("% left"))
    throw new Error("the bars do not show what is left");
  await shoot(page, "quotas-tuned");

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
  await page.getByRole("link", { name: "Settings" }).click();
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
  const codeB = (
    await pageB
      .getByTestId("pairing-code")
      .filter({ hasText: /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/ })
      .textContent({ timeout: 10_000 })
  )?.trim();
  if (!codeB) throw new Error("no pairing code on the second browser");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Add a device" }).click();
  await page.getByLabel("Pair a machine or device").fill(codeB);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByText(/read and answer as a device/).waitFor();
  await page.getByRole("button", { name: "Approve" }).click();
  await pageB.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  // The new device sees decisions sealed after it joined; the open one predates it.

  step("recover a third browser with the words");
  const c = await ff.newContext();
  const pageC = await signIn(c);
  await pageC.getByRole("button", { name: "Use the recovery key" }).click();
  await pageC.getByLabel("Your 24 recovery words").fill(words);
  await pageC.getByRole("button", { name: "Recover" }).click();
  await pageC.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });

  step("revoke the second browser");
  await page.getByRole("link", { name: "Settings" }).click();
  const devices = page.getByRole("region", { name: "Devices" });
  await devices.getByText("Device · this browser").waitFor();
  // Devices list this browser, then the others by when they joined: the second browser first.
  const before = await devices.getByRole("button", { name: "Revoke" }).count();
  await devices.getByRole("button", { name: "Revoke" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  if ((await devices.getByRole("button", { name: "Revoke" }).count()) !== before - 1)
    throw new Error("the revoked browser is still listed");
  await pageB.reload();
  await pageB.getByRole("link", { name: SIGN_IN }).waitFor();
  await page.emulateMedia({ colorScheme: "light" });
  await shoot(page, "devices");

  step("a pairing link opened while signed out keeps its code through GitHub sign-in");
  const linked = cli("pair-link", ["pair", "--name", "laptop"], join(tmp, "laptop"));
  const code3 = (await linked.waitFor(/Pairing code: (\S+)/))[1] as string;
  await a.clearCookies();
  await page.goto(`${ORIGIN}/pair#${code3}`);
  await page.getByRole("link", { name: SIGN_IN }).click();
  await page.getByText("Let laptop post decisions and quotas?").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await linked.waitFor(/Paired "laptop"/);
  if ((await linked.exited) !== 0) throw new Error("pair by link failed");

  step("sign in again: the session binds to the existing device without pairing");
  await a.clearCookies();
  await page.goto(ORIGIN);
  await page.getByRole("link", { name: SIGN_IN }).click();
  await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  await page.getByText("Merge #19 (server) before the web PR rebases?").first().waitFor();

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
