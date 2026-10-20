// End-to-end run on one machine: the real server, the built web page, the real CLI, Firefox
// through Playwright, and the stand-ins in services.ts for GitHub and the Web Push service.
//
//   xvfb-run -a node web/e2e/run.ts      (Node 22.6+ runs this TypeScript as is)
//
// Needs `npx playwright install firefox` once. Writes screenshots to web/screenshots.
//
// EVIDENCE=<folder> writes the PR's evidence there instead (docs/ci.md, "Evidence"): the
// screenshots in shots/ at 360, 768 and 1280 px, light and dark; a Playwright trace per browser;
// and manifest.json, the steps driven and the result.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Locator,
  Page,
  Route,
} from "playwright";
import { layoutProblems, type Problem, zoomText } from "./layout.ts";
import {
  boot,
  browser,
  children,
  cli,
  machineEnv,
  ORIGIN,
  PORTS,
  ROOT,
  shutdown,
  step,
  steps,
  tmp,
  WEB,
} from "./stack.ts";
import { volatile } from "./volatile.ts";

const EVIDENCE = process.env.EVIDENCE;
const SHOTS = EVIDENCE ? join(EVIDENCE, "shots") : join(WEB, "screenshots");
// Set to a folder to record the inbox's motion there, as one GIF per motion (needs ffmpeg).
const MOTION_VIDEO = process.env.MOTION_VIDEO;
const DESKTOP = { width: 1280, height: 860 };
/**
 * E2E_SHARD runs one part, so CI runs the three side by side, each with its own server and
 * browser. Each part signs in, sets up the first browser and pairs a machine; then "inbox" runs
 * one browser's inbox, quotas and layouts, "snooze" a second browser's snooze, and "devices" the
 * second browser's other steps, the holds, recovery key and sign-ins. Unset, it runs them all.
 */
const SHARD = process.env.E2E_SHARD;
if (SHARD && !["inbox", "snooze", "devices"].includes(SHARD))
  throw new Error(`E2E_SHARD is inbox, snooze or devices, not ${SHARD}`);
const runs = (shard: string) => !SHARD || SHARD === shard;
/** The artifact two steps answer a question in. */
const ARTIFACT = "https://claude.ai/artifact/Xq7pLm2VnR4tBz9KcW1sYd";

/**
 * The instant the quota fixtures were made for: a quota screen is shot with the page's clock
 * there, so the pace marker and its "On pace" or "Headroom unused" do not follow how long the
 * run took to get to the shot.
 */
let dataNow: number | undefined;
/** The first browser's pages that turned Web Push on, so a dropped subscription is turned on again. */
const pushOn = new WeakSet<Page>();

/** When the CodexBar fixtures in cli/test/fixtures/codexbar were recorded. */
const RECORDED = Date.parse("2026-10-04T19:09:00Z");

/**
 * The fake CodexBar, replaying a copy of its fixtures whose times are moved to this run's clock:
 * with their recorded dates, which windows run out depended on the day (#902).
 */
function fakeCodexbar(): string {
  dataNow = Date.now();
  const shift = dataNow - RECORDED;
  const dir = join(tmp, "codexbar-fixture");
  mkdirSync(join(dir, "codexbar"), { recursive: true });
  const fixtures = join(ROOT, "cli/test/fixtures");
  cpSync(join(fixtures, "fake-codexbar.sh"), join(dir, "fake-codexbar.sh"));
  for (const f of readdirSync(join(fixtures, "codexbar"))) {
    const text = readFileSync(join(fixtures, "codexbar", f), "utf8").replace(
      /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g,
      (t) => new Date(Date.parse(t) + shift).toISOString().replace(/\.\d+Z$/, "Z"),
    );
    writeFileSync(join(dir, "codexbar", f), text);
  }
  return join(dir, "fake-codexbar.sh");
}

/** Two PNGs to attach to a decision: the sample data's pair of layouts (lib/sample.ts). */
function image(which: "a" | "b"): string {
  const shots = JSON.parse(readFileSync(join(WEB, "src/lib/sample-shots.json"), "utf8"));
  const path = join(tmp, `hero-${which}.png`);
  writeFileSync(path, Buffer.from(shots[which.toUpperCase()], "base64url"));
  return path;
}

/**
 * Follows a link to `path`. Right after a navigation a click now and then does nothing, as with
 * `choose` (#879: the recovery key's Replace link, and Add a device, left the page on Settings),
 * so this clicks again until the address is `path`.
 */
async function follow(page: Page, link: Locator, path: string) {
  for (let tries = 1; ; tries++) {
    await link.click();
    try {
      await page.waitForURL((u) => u.pathname === path, { timeout: 5_000 });
      return;
    } catch (e) {
      if (tries === 3) throw e;
      console.log(
        `follow: still at ${new URL(page.url()).pathname} after click ${tries}, clicking again`,
      );
    }
  }
}

/** The first Tab reaches a skip link, shown only now, and Enter on it focuses the page's main. */
async function skipToContent(page: Page) {
  const skip = page.getByRole("link", { name: "Skip to content" });
  const rect = () => skip.evaluate((a) => a.getBoundingClientRect().bottom);
  if ((await rect()) > 0) throw new Error("the skip link shows before the keyboard reaches it");
  await page.locator("body").press("Tab");
  if (!(await skip.evaluate((a) => a === document.activeElement)))
    throw new Error("the first Tab does not reach the skip link");
  if ((await rect()) <= 0) throw new Error("the skip link stays hidden on focus");
  await page.keyboard.press("Enter");
  if ((await page.evaluate(() => document.activeElement?.id)) !== "main")
    throw new Error("the skip link does not focus the main content");
}

/**
 * Picks an option of a Settings segmented control. Its radio hides inside the segment, which
 * takes the click. Right after a navigation the click now and then leaves the radio as it was
 * (#693, #758), so this clicks again until the radio is checked. It waits for the checked state
 * in the DOM, since the radio is never visible.
 */
async function choose(page: Page | Locator, label: string) {
  const radio = page.getByLabel(label, { exact: true });
  const checked = radio.and(page.locator(":checked"));
  for (let tries = 1; ; tries++) {
    await radio.click({ force: true });
    try {
      await checked.waitFor({ state: "attached", timeout: 3_000 });
      return;
    } catch (e) {
      if (tries === 5) throw e;
      console.log(`choose: ${label} not checked after click ${tries}, clicking again`);
    }
  }
}

/**
 * The owner's side of a machine's check code (#795): the code the page shows after Approve must
 * be the one `starbridge pair` printed, then `pair --confirm` answers its question.
 */
async function confirmCheck(page: Page, pair: ReturnType<typeof cli>, name: string, home: string) {
  const printed = (await pair.waitFor(/Check code: (\S+)/))[1] as string;
  const shown = await page.getByTestId("check-code").textContent();
  if (shown !== `Check code ${printed}`)
    throw new Error(`the page shows "${shown}", the terminal ${printed}`);
  if ((await cli(`${name}-confirm`, ["pair", "--confirm"], home).exited) !== 0)
    throw new Error("pair --confirm failed");
  return printed;
}

/** Content-Security-Policy violations on any page; the run fails on any (#312). */
const violations: string[] = [];

async function watchCsp(ctx: BrowserContext) {
  await ctx.exposeBinding("cspViolation", ({ page }, v: string) => {
    violations.push(`${page.url()}: ${v}`);
  });
  await ctx.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { cspViolation: (v: string) => void }).cspViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    ),
  );
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

/**
 * #630: a session name cut into a head and a tail keeps the space at the cut. Each half is a
 * flex item, whose line would drop it ("Starbridgeorchestrator"). Measures the gap between the
 * glyphs on either side of the cut; skips a head shown with an ellipsis.
 */
async function keepsSessionSpace(page: Page, at: string) {
  const found = await page.evaluate(() => {
    const glyph = (node: Node, i: number) => {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      return r.getBoundingClientRect();
    };
    const rows: { name: string; gap: number | null }[] = [];
    for (const el of document.querySelectorAll("[title]")) {
      const [head, tail] = [...el.children] as HTMLElement[];
      const name = el.getAttribute("title") ?? "";
      if (el.children.length !== 2 || !head || !tail) continue;
      if (`${head.textContent}${tail.textContent}` !== name) continue;
      const h = head.firstChild;
      const t = tail.firstChild;
      const cut = head.textContent?.length ?? 0;
      if (!h || !t || !/\s/.test(`${name[cut - 1]}${name[cut]}`)) continue;
      if (head.scrollWidth > head.clientWidth) {
        rows.push({ name, gap: null });
        continue;
      }
      const last = (head.textContent ?? "").trimEnd().length - 1;
      const first = (tail.textContent ?? "").length - (tail.textContent ?? "").trimStart().length;
      if (last < 0 || first >= (tail.textContent ?? "").length) continue;
      rows.push({ name, gap: glyph(t, first).left - glyph(h, last).right });
    }
    return rows;
  });
  const measured = found.filter((r) => r.gap !== null);
  if (measured.length === 0) throw new Error(`no session name cut at a space to measure at ${at}`);
  for (const r of measured)
    if ((r.gap as number) < 2)
      throw new Error(`"${r.name}" loses the space at its cut at ${at}: ${r.gap} px between words`);
}

/** What fails the run; contrast is only listed. */
const FAILS: Problem["kind"][] = ["page-width", "clipped", "spills", "offscreen", "overlap", "tap"];

/** Fails on what a screenshot would show broken (layout.ts); AUDIT lists it instead. */
async function fitsLayout(page: Page, name: string) {
  const problems = await layoutProblems(page);
  if (AUDIT) {
    const at = await page.evaluate(() => `${innerWidth}`);
    for (const p of problems)
      appendFileSync(join(AUDIT, "problems.jsonl"), `${JSON.stringify({ name, at, ...p })}\n`);
    return;
  }
  const broken = problems.filter((p) => FAILS.includes(p.kind));
  if (broken.length)
    throw new Error(
      `${name} at ${page.viewportSize()?.width} px:\n${broken.map((p) => `  ${p.kind}: ${p.what}`).join("\n")}`,
    );
}

// AUDIT=<folder> shoots every size into that folder, phones' text at 200% too, and writes what
// the checks find to problems.jsonl there instead of failing.
const AUDIT = process.env.AUDIT;
const SIZES = AUDIT
  ? ([
      ...(
        [
          [320, 568],
          [360, 780],
          [390, 844],
          [430, 932],
          [768, 1024],
          [1024, 768],
          [1280, 800],
          [1440, 900],
          [1920, 1080],
        ] as const
      ).map(([width, height]) => [`${width}`, { width, height }, 1] as const),
      ["390-text200", { width: 390, height: 844 }, 2] as const,
    ] as const)
  : EVIDENCE
    ? ([
        ["phone", { width: 360, height: 780 }, 1],
        ["tablet", { width: 768, height: 1024 }, 1],
        ["desktop", DESKTOP, 1],
      ] as const)
    : ([
        ["phone", { width: 390, height: 844 }, 1],
        ["desktop", DESKTOP, 1],
      ] as const);

/** A reply long enough to wrap past 10 lines at a phone's width (#947). */
const LONG_REPLY =
  "Not quite. Keep the API change first, but split the migration into its own PR so the checkout one stays reviewable, and before you merge anything rerun the full test suite against staging with the new routes, then show me the diff of api/orders.ts and the two failing snapshots you mentioned yesterday so I can decide whether to update them or fix the rendering. ".repeat(
    2,
  );

/**
 * A long reply never runs under the send button (#947): at each width, the text's box ends above
 * the button's, and past 10 lines the field scrolls instead of growing. The draft survives each
 * move between the phone and wide layouts, 1280 px back to 390 px too (#992). Leaves the field empty,
 * at the phone's width, reopening the question there with `reopen`.
 */
async function replyClear(page: Page, reply: Locator, reopen: () => Promise<void>) {
  const send = page.getByRole("button", { name: "Send" });
  const size = page.viewportSize() ?? DESKTOP;
  await reply.fill(LONG_REPLY);
  for (const width of [320, 390, 600, 900, 1280]) {
    await page.setViewportSize({ width, height: size.height });
    await page.waitForTimeout(100);
    // The draft survives the detail moving between the phone and wide layouts (#992).
    if ((await reply.inputValue()) !== LONG_REPLY)
      throw new Error(`at ${width} px the reply's draft is lost`);
    const [text, button] = [await reply.boundingBox(), await send.boundingBox()];
    if (!text || !button) throw new Error(`at ${width} px the reply field or Send is not shown`);
    const overlaps =
      text.x < button.x + button.width &&
      button.x < text.x + text.width &&
      text.y < button.y + button.height &&
      button.y < text.y + text.height;
    if (overlaps)
      throw new Error(
        `at ${width} px the reply's text runs under Send: ${JSON.stringify({ text, button })}`,
      );
    const { scroll, client } = await reply.evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
    }));
    if (width === 320 && scroll <= client)
      throw new Error(`at 320 px a long reply grows the field (${client} px) instead of scrolling`);
  }
  for (const [name, viewport] of [
    ["desktop", DESKTOP],
    ["phone", size],
  ] as const) {
    await page.setViewportSize(viewport);
    // Narrowed from the wide layout, the phone is back on the list.
    if (!(await reply.isVisible())) await reopen();
    if ((await reply.inputValue()) !== LONG_REPLY)
      throw new Error(`at ${name} width the reply's draft is lost`);
    // The whole box, its send row too, clear of the phone's bottom bar.
    await reply.evaluate((el) => el.closest("form")?.scrollIntoView({ block: "center" }));
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.waitForTimeout(150);
      await fitsLayout(page, `long reply ${scheme}`);
      await capture(page, join(SHOTS, `reply-long-${name}-${scheme}.png`));
    }
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await reply.fill("");
}

/**
 * A screenshot of a page or one element at `path`. With EVIDENCE, the boxes of what changes from
 * run to run go beside it (volatile.ts).
 */
async function capture(target: Page | Locator, path: string, fullPage = false) {
  const quota = EVIDENCE && dataNow !== undefined && /\/(quotas-|inbox-aside)/.test(path);
  const clockPage = "page" in target ? target.page() : target;
  if (quota) await clockPage.clock.setFixedTime(dataNow as number);
  try {
    await capture1(target, path, fullPage);
  } finally {
    if (quota) await clockPage.clock.setSystemTime(Date.now());
  }
}

async function capture1(target: Page | Locator, path: string, fullPage: boolean) {
  if (EVIDENCE) {
    const page = "page" in target ? target.page() : target;
    const box = "page" in target ? await target.boundingBox() : { x: 0, y: 0 };
    const rects = (await volatile(page, fullPage)).map((r) => ({
      ...r,
      x: r.x - (box?.x ?? 0),
      y: r.y - (box?.y ?? 0),
    }));
    writeFileSync(path.replace(/\.png$/, ".json"), JSON.stringify(rects));
  }
  await target.screenshot({ path, fullPage });
}

/**
 * Closing a section leaves its head, still open to reopen (#1824). The rows fade out for a
 * moment first, and the head used to go with them, so this waits that out, with motion on.
 */
async function foldKeepsHead(page: Page, head: Locator) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await head.click();
  await page.waitForTimeout(800);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  if ((await head.count()) !== 1 || (await head.getAttribute("aria-expanded")) !== "false")
    throw new Error(`a closed section lost its head: ${head}`);
  // Toggled again before the rows finish fading, React must still find its nodes (insertBefore
  // threw "not a child of this node" and the page fell to "Something went wrong").
  try {
    for (let i = 0; i < 6; i++) {
      await head.click({ timeout: 3000 });
      await page.waitForTimeout(60 + 40 * (i % 3));
    }
  } catch {
    throw new Error(`toggling a section took its head: ${head}`);
  }
  await page.waitForTimeout(800);
  if (await page.getByText("Something went wrong").count())
    throw new Error(`toggling a section crashed the page: ${head}`);
  if ((await head.count()) !== 1) throw new Error(`a toggled section lost its head: ${head}`);
}

/**
 * Firefox drops a browser's push subscription now and then (docs/ci.md, "Evidence"), which puts
 * the Turn on notifications banner on a screen; turn it on again, as the run did at first.
 */
async function pushBack(page: Page) {
  const banner = page.getByRole("button", { name: "Turn on notifications" });
  if (!EVIDENCE || !pushOn.has(page) || !(await banner.isVisible())) return;
  await banner.click();
  await banner.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
}

async function shoot(page: Page, name: string) {
  for (const [size, viewport, text] of SIZES)
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      // Without motion, so no row is caught sliding over another.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.waitForTimeout(150);
      await pushBack(page);
      const unzoom = text > 1 ? await zoomText(page, text) : undefined;
      await fitsLayout(page, `${name} ${scheme}${unzoom ? " text 200%" : ""}`);
      await pushBack(page);
      // Firefox draws the phone layout's fixed bottom bar mid-page in a full-page capture.
      await capture(
        page,
        join(AUDIT ?? SHOTS, `${name}-${size}-${scheme}.png`),
        AUDIT !== undefined || viewport.width >= 600,
      );
      await unzoom?.();
    }
  // The narrowest phones are checked too, without a shot.
  if (!AUDIT) {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(150);
    await fitsLayout(page, name);
  }
  // The steps after a shot carry on at the desktop size, as the last of the default sizes leaves.
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

let failPage: Page | undefined;
let ff: Browser | undefined;
const contexts: BrowserContext[] = [];

/** A browser's context, traced when the run keeps evidence. */
async function context(opts: BrowserContextOptions) {
  if (!ff) throw new Error("no browser yet");
  const ctx = await ff.newContext(opts);
  contexts.push(ctx);
  if (EVIDENCE) await ctx.tracing.start({ snapshots: true, screenshots: false });
  return ctx;
}

/** Saves each browser's trace and the manifest; the run's result is `error`'s absence. */
async function keepEvidence(error?: unknown) {
  if (!EVIDENCE) return;
  for (const [i, ctx] of contexts.entries())
    await ctx.tracing.stop({ path: join(EVIDENCE, `trace-${i + 1}.zip`) }).catch(() => {});
  const manifest = {
    shard: SHARD ?? "all",
    passed: error === undefined,
    error: error === undefined ? undefined : String(error).slice(0, 2000),
    steps,
    sizes: SIZES.map(([name, viewport]) => ({ name, ...viewport })),
  };
  writeFileSync(join(EVIDENCE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The same-second and late cases that kept coming back as bugs (#2103): which snooze or waiting
 * state wins must not depend on which client sent it, its clock, or what arrived first. Browser
 * `pageB`'s clock runs 30 s ahead, as a phone's may, or as a snooze Android or iOS stamps a second
 * ahead of the last one; `page` is right. The CLI is the machine.
 */
async function orderAcrossClients(page: Page, pageB: Page, home: string) {
  step(
    "a snooze from a clock ahead, then Back now within its lead: every client shows it back (#2103)",
  );
  const ask = cli(
    "order-ask",
    [
      ...["ask", "--question", "Order probe: tag the release?", "--option", "Tag"],
      ...["--option", "Wait", "--project", "starbridge", "--session", "e2e"],
    ],
    home,
  );
  const [id] = await ask.waitFor(/d_[\w-]+/);
  if ((await ask.exited) !== 0) throw new Error("ask for the order probe failed");
  const row = (p: Page) => p.locator(`button[data-id="${id}"]`);
  const selected = (p: Page) => p.locator('section[aria-label="Selected"]');
  await pageB.clock.setSystemTime(new Date(Date.now() + 30_000));
  await pageB.reload();
  await row(pageB).click({ timeout: 30_000 });
  await selected(pageB).getByRole("button", { name: "Snooze", exact: true }).click();
  await pageB.getByRole("button", { name: /^1 hour/ }).click();
  await row(pageB).waitFor({ state: "detached", timeout: 10_000 });
  // The first browser learns of that snooze, then brings the question back at once.
  await page.reload();
  await page.getByRole("button", { name: /^Snoozed\s*1/ }).click({ timeout: 30_000 });
  await row(page).click({ timeout: 30_000 });
  await selected(page).getByRole("button", { name: "Back now" }).click();
  const backAt = Date.now();
  await page.getByRole("button", { name: /^Snoozed\s*1/ }).waitFor({ state: "detached" });
  if (Date.now() - backAt > 25_000) console.log("  Back now took longer than the clock's lead");
  // The machine keeps Back now: `waiting` says nothing about a snooze.
  const waiting = cli("order-waiting", ["waiting", id as string], home);
  if ((await waiting.exited) !== 0) throw new Error("waiting on the order probe failed");
  if (/Snoozed d_/.test(waiting.output()))
    throw new Error(`the machine kept the earlier snooze over Back now: ${waiting.output()}`);
  await pageB.reload();
  await row(pageB).waitFor({ timeout: 30_000 });

  step(
    "waiting, then working within a second: every client shows the agent working (#1982, #2103)",
  );
  // Right after `waiting` above, as an agent that blocks and then goes on would.
  const working = cli("order-working", ["working", id as string], home);
  if ((await working.exited) !== 0) throw new Error("working on the order probe failed");
  for (const p of [page, pageB]) {
    await p.reload();
    await row(p).waitFor({ timeout: 30_000 });
    await p.getByRole("button", { name: /^Order probe/ }).waitFor({ timeout: 30_000 });
    if (await p.getByRole("button", { name: /^Waiting for you.*Order probe/ }).count())
      throw new Error("a browser kept the agent waiting after it went back to work");
  }

  step("answered on one browser while the other is offline: back online, it shows the answer");
  await pageB.context().setOffline(true);
  const wait = cli("order-wait", ["wait", id as string, "--timeout", "60s"], home);
  await row(page).click();
  await selected(page).getByRole("button", { name: /^Tag/ }).click();
  await wait.waitFor(/Answer to d_\S+ \(Order probe: tag the release\?\): Tag/);
  if ((await wait.exited) !== 0) throw new Error("wait on the order probe failed");
  await pageB.context().setOffline(false);
  await pageB.clock.setSystemTime(new Date());
  await pageB.reload();
  await row(pageB).waitFor({ state: "detached", timeout: 30_000 });
}

/** The kept inbox's records in this browser's IndexedDB: the lists and their images (#2097). */
async function keptRecords(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((done, fail) => {
      const q = indexedDB.open("starbridge");
      q.onsuccess = () => done(q.result);
      q.onerror = () => fail(q.error);
    });
    const keys: IDBValidKey[] = await new Promise((done) => {
      const q = db.transaction("kv").objectStore("kv").getAllKeys();
      q.onsuccess = () => done(q.result);
    });
    db.close();
    return keys.map(String).filter((k) => /^(kept|blobs):/.test(k));
  });
}

/**
 * What a reload of an inbox with a kept history may cost before its open question shows (#2097):
 * a 4x slower CPU took 8.5 s when a load read the directory 5 times and opened the whole history
 * first (#1450). The open question must show while the rest of the inbox still loads, after one
 * read of the directory, and without downloading again the images this browser keeps.
 */
async function loadBudget(page: Page) {
  step("a reload shows the open question first, within its budget of requests (#2097)");
  const BUDGET = { requests: 16, directory: 1, kb: 96 };
  const open = page.getByText("Merge #19 (server) before the web PR rebases?").first();
  await page.goto(ORIGIN);
  await open.waitFor({ timeout: 30_000 });
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  // The rest of the inbox waits until the open question shows.
  const rest = /\/v1\/items\?kind=decision,settled,waiting,snooze&after=/;
  const hold = async (route: Route) => {
    await Promise.race([held, new Promise((done) => setTimeout(done, 20_000))]);
    await route.fallback();
  };
  await page.route(rest, hold);
  const reads: { url: string; bytes: Promise<number> }[] = [];
  const seen = (r: import("playwright").Request) => {
    if (!r.url().includes("/v1/")) return;
    reads.push({
      url: r.url().replace(ORIGIN, ""),
      bytes: r
        .response()
        .then(async (res) => (res ? (await res.body()).length : 0))
        .catch(() => 0),
    });
  };
  page.on("request", seen);
  const t0 = Date.now();
  await page.reload();
  await open.waitFor({ timeout: 15_000 }).catch(() => {
    throw new Error("the open question waited for the rest of the inbox to load (#1458)");
  });
  const ms = Date.now() - t0;
  page.off("request", seen);
  const before = [...reads];
  release();
  await page.unroute(rest, hold);
  const sizes = await Promise.all(before.map((r) => r.bytes));
  const kb = Math.round(sizes.reduce((a, b) => a + b, 0) / 1024);
  const directory = before.filter((r) => r.url.startsWith("/v1/directory")).length;
  console.log(
    `load budget: shown in ${ms} ms after ${before.length} requests, ${kb} KB, ${directory} directory reads`,
  );
  const over = [
    before.length > BUDGET.requests && `${before.length} requests (budget ${BUDGET.requests})`,
    directory > BUDGET.directory && `${directory} directory reads (budget ${BUDGET.directory})`,
    kb > BUDGET.kb && `${kb} KB (budget ${BUDGET.kb})`,
  ].filter(Boolean);
  if (over.length > 0)
    throw new Error(
      `a reload before the open question shows: ${over.join(", ")}\n${before.map((r, i) => `${r.url} ${sizes[i]} B`).join("\n")}`,
    );
  // The kept list holds no image: each sits in its own record, read when shown (#2097).
  const inline = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((done, fail) => {
      const q = indexedDB.open("starbridge");
      q.onsuccess = () => done(q.result);
      q.onerror = () => fail(q.error);
    });
    const all: unknown[] = await new Promise((done) => {
      const q = db
        .transaction("kv")
        .objectStore("kv")
        .getAll(IDBKeyRange.bound("kept:", "kept:\uffff"));
      q.onsuccess = () => done(q.result);
    });
    db.close();
    return (all as { items: { item: { blobs?: string[] } }[] }[])
      .flatMap((k) => k.items)
      .filter((k) => k.item.blobs).length;
  });
  if (inline > 0) throw new Error(`the kept list holds ${inline} items' images`);
  // A server from before blobs=none refuses it: the page reads the open list with images instead.
  const old = /\/v1\/items\?kind=decision&open=1&blobs=none/;
  const refuse = (route: Route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "bad-request", detail: "blobs is open or left out" }),
    });
  await page.route(old, refuse);
  await page.reload();
  await open.waitFor({ timeout: 15_000 });
  await page.unroute(old, refuse);
}

async function main() {
  mkdirSync(AUDIT ?? SHOTS, { recursive: true });

  step("services, server, web");
  const { services } = await boot();

  ff = await browser();
  const a = await context({
    permissions: ["notifications"],
    ...(MOTION_VIDEO ? { recordVideo: { dir: join(tmp, "video"), size: DESKTOP } } : {}),
  });

  await watchCsp(a);

  if (runs("inbox")) {
    step("a browser with no device lands on the landing page");
    const visitor = await a.newPage();
    const landing = await visitor.goto(ORIGIN);
    const policy = landing?.headers()["content-security-policy"] ?? "";
    if (!policy.includes("'nonce-")) throw new Error(`expected a CSP with a nonce, got: ${policy}`);
    // The server's HTML is the landing page itself, for link previews and a first paint (#694).
    const html = (await landing?.text()) ?? "";
    for (const part of [
      "Know the moment your agent is stuck",
      'property="og:image"',
      policy.split("'nonce-")[1]?.split("'")[0] ?? "-",
    ])
      if (!html.includes(part)) throw new Error(`expected the landing page's HTML to hold ${part}`);
    await visitor.getByRole("heading", { name: /Know the moment your agent is stuck/ }).waitFor();
    await shoot(visitor, "landing");
    for (const [path, name] of [
      ["/docs", "docs"],
      ["/docs/tell-your-agents", "docs-tell-your-agents"],
      ["/privacy", "privacy"],
      ["/terms", "terms"],
      ["/no-such-page", "not-found"],
    ]) {
      await visitor.goto(ORIGIN + path);
      await shoot(visitor, name);
    }
    for (const path of [
      "/docs",
      "/docs/cli",
      "/docs/tell-your-agents",
      "/docs/self-host",
      "/docs/faq",
      "/sample",
    ])
      await visitor.goto(ORIGIN + path, { waitUntil: "networkidle" });
    step("docs: code blocks scroll from the keyboard, and a skip link leads past the nav (#1944)");
    await visitor.goto(`${ORIGIN}/docs/cli`);
    const blocks = await visitor
      .locator("article pre")
      .evaluateAll((pres) =>
        pres.map((p) => [
          p.getAttribute("tabindex"),
          p.getAttribute("role"),
          p.getAttribute("aria-label"),
        ]),
      );
    if (blocks.length === 0 || blocks.some(([i, r, l]) => i !== "0" || !r || !l))
      throw new Error(`a docs code block is not keyboard-scrollable: ${JSON.stringify(blocks)}`);
    await skipToContent(visitor);
    await visitor.close();
  }

  step("sign in with GitHub (stub) and set up the first device");
  const page = await signIn(a);
  failPage = page;
  await page.getByRole("button", { name: "Create the keys" }).click();
  await page.getByRole("heading", { name: "Save your recovery key" }).waitFor();
  const unsaved = ((await page.getByTestId("recovery-key").textContent()) ?? "").trim();

  step("a reload before the key is saved offers a new key, not the inbox (#328)");
  await page.reload();
  await page.getByText(/so that key was never used/).waitFor();
  await page.getByRole("button", { name: "Create the keys" }).click();
  await page.getByRole("heading", { name: "Save your recovery key" }).waitFor();
  const key = ((await page.getByTestId("recovery-key").textContent()) ?? "").trim();
  if (key === unsaved) throw new Error("expected a new recovery key after the reload");
  if (!/^([0-9A-Z]{4}){7}$/.test(key)) throw new Error(`expected a recovery key, got: ${key}`);
  await noWordsAsked(page);
  await shoot(page, "setup");
  if ((await page.locator('header a[href="/"]').count()) !== 1)
    throw new Error("the first-run page's brand link is outside a header landmark");
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByLabel(/I wrote this key down/).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Inbox" }).waitFor();
  // No machine yet: the inbox says how to add one (#610).
  await page.getByRole("heading", { name: "Add a machine" }).waitFor();
  // The banner follows once the page has checked the push subscription, as the next step uses it.
  await page.getByRole("button", { name: "Turn on notifications" }).waitFor();
  await shoot(page, "inbox-empty");
  step("the app's skip link leads past the rail (#1944)");
  await skipToContent(page);

  step("turn on Web Push");
  await page.getByRole("button", { name: "Turn on notifications" }).click();
  await services.waitFor(/"event":"subscribed"/);
  await page.getByRole("button", { name: "Turn on notifications" }).waitFor({ state: "detached" });
  pushOn.add(page);

  step("approve `starbridge pair` from the empty inbox's Add a device (#1367)");
  const machineHome = join(tmp, "machine");
  const pair = cli("pair", ["pair", "--name", "devbox"], machineHome);
  const code = (await pair.waitFor(/Pairing code: (\S+)/))[1] as string;
  await follow(page, page.getByRole("link", { name: "Add a device" }), "/settings/devices/add");
  await page.getByLabel("Pair a machine or device").fill(code);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  const devboxCheck = await confirmCheck(page, pair, "pair", machineHome);
  await pair.waitFor(/✓ Paired as devbox/);
  if ((await pair.exited) !== 0) throw new Error("pair failed");
  await page.getByRole("status", { name: "Pairing result" }).getByText("devbox joined").waitFor();
  await shoot(page, "pair-joined");
  const signedIn = await page.goto(`${ORIGIN}/`);
  if ((await signedIn?.text())?.includes("Know the moment"))
    throw new Error("a signed-in browser got the landing page's HTML");
  await page.getByText("Nothing needs you").waitFor();
  if ((await page.title()) !== "Starbridge · Inbox")
    throw new Error(`expected the Inbox's title, got: ${await page.title()}`);
  if (await page.getByRole("heading", { name: "Add a machine" }).count())
    throw new Error("the inbox still says to add a machine after one joined");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();

  const selected = (p: Page) => p.locator('section[aria-label="Selected"]');
  // The "devices" shard leaves this open too, for its sign-in to decrypt.
  const leaveOpen = async () => {
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
  };

  if (runs("inbox")) {
    step("Devices shows the machine's check code while its pairing can be confirmed (#939)");
    {
      const row = page
        .getByRole("region", { name: "Devices" })
        .getByTestId("device")
        .filter({ hasText: "devbox" });
      const shown = await row.getByTestId("device-check").textContent();
      if (shown !== `Same code as on the machine? ${devboxCheck}`)
        throw new Error(`Devices shows "${shown}" beside devbox, the terminal ${devboxCheck}`);
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(150);
        await capture(row, join(SHOTS, `devices-check-row-${scheme}.png`));
      }
      await page.emulateMedia({ colorScheme: "light" });
      // A page whose clock runs on: the code leaves once `starbridge pair` stops waiting for it.
      // The clock is the whole context's, so it goes back to now before the next step.
      const later = await a.newPage();
      await later.clock.install();
      await later.goto(`${ORIGIN}/settings`);
      const check = later.getByRole("region", { name: "Devices" }).getByTestId("device-check");
      await check.waitFor();
      await later.clock.fastForward(60 * 60_000);
      await check.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {
        throw new Error("Devices still shows devbox's check code an hour after it was added");
      });
      await later.clock.setSystemTime(new Date());
      await later.close();
    }
    await follow(page, page.getByRole("link", { name: "Add a device" }), "/settings/devices/add");

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
    // CI uploads the fixture: a runner's own CodexBar would read whoever's accounts it has.
    const real =
      !process.env.CI && spawnSync("codexbar", ["--version"], { encoding: "utf8" }).status === 0;
    const quota = cli(
      "quota",
      [
        "quota",
        "push",
        "--once",
        ...(real ? [] : ["--codexbar", fakeCodexbar()]),
        ...["claude", "codex", "zai", "mistral"].flatMap((p) => ["--provider", p]),
      ],
      machineHome,
    );
    if ((await quota.exited) !== 0) throw new Error("quota push failed");

    step("answer `starbridge ask --wait` from the inbox, with a Web Push for it");
    await page.getByRole("link", { name: /^Inbox/ }).click();
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
    await ask.waitFor(
      /Answer to d_\S+ \(Run the migration on the staging database now\?\): Run it/,
    );
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
    // The tabs settle first (#1973): Quotas joins them once the page reads the snapshot uploaded
    // above, at its next read of quotas, since quota pushes go to phones only.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Quotas" })
      .waitFor({ timeout: 65_000 });
    await shoot(page, "inbox-cleared");
    await page.getByRole("button", { name: /History/ }).click();

    step(
      "an answer leaves the inbox on the frame after the click, before the server replies; a refused one comes back saying why (#895)",
    );
    // Every request waits the hosted server's round trip from a dev box (48 ms, warm connection).
    await page.route("**/v1/**", async (route) => {
      await new Promise((done) => setTimeout(done, 48));
      await route.fallback();
    });
    /** The open question's row, by its question. */
    const needRow = (question: string) =>
      page.getByRole("button", {
        name: new RegExp(`${question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      });
    /** Asks, selects the question, clicks `option` in its detail, and times its row's leaving in frames and ms. */
    const answerTimed = async (question: string, option: string, wait = false) => {
      const asked = cli(
        "probe",
        [
          ...["ask", "--question", question, "--option", option, "--option", "Not now"],
          ...["--project", "starbridge", "--session", "e2e", ...(wait ? ["--wait"] : [])],
        ],
        machineHome,
      );
      await asked.waitFor(/^d_\S+$/m);
      // The push brings the row: a reload per probe would spend the per-address rate limit that
      // later steps' answers need.
      await needRow(question).first().click({ timeout: 30_000 });
      const button = page
        .locator('section[aria-label="Selected"]')
        .getByRole("button", { name: new RegExp(`^${option}`) });
      await button.waitFor();
      // Navigating away mid-POST would drop the answer: callers wait for its reply first.
      const posted = page.waitForResponse(
        (r) => r.url().endsWith("/v1/items") && r.request().method() === "POST",
      );
      const left = await button.evaluate(async (b, q) => {
        const listed = () =>
          [...document.querySelectorAll("[data-row] button[data-id]")].some((r) =>
            r.getAttribute("aria-label")?.endsWith(q),
          );
        const t0 = performance.now();
        (b as HTMLButtonElement).click();
        let frames = 0;
        while (listed() && frames < 600) {
          await new Promise((done) => requestAnimationFrame(done));
          frames++;
        }
        return { frames, ms: Math.round(performance.now() - t0) };
      }, question);
      return { asked, left, posted };
    };
    const timed = await answerTimed("Timing probe: tag the release?", "Tag");
    console.log(`answer click to row gone, 48 ms per request: ${JSON.stringify(timed.left)}`);
    await timed.posted;
    // Held at the server: the row is gone by the next frame all the same.
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let refuse = false;
    await page.route("**/v1/items", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      if (refuse)
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "bad-schema", message: "refused by the e2e run" }),
        });
      await gate;
      await route.fallback();
    });
    const holding = await answerTimed("Held probe: deploy now?", "Deploy");
    release();
    await holding.posted;
    if (holding.left.frames > 1)
      throw new Error(
        `the answered row stayed ${holding.left.frames} frames while the server held the answer`,
      );
    // Refused: gone at once, then back with why; answering again sends it.
    refuse = true;
    const refused = await answerTimed("Refused probe: merge?", "Merge", true);
    if (refused.left.frames > 1) throw new Error("the refused answer's row did not leave at once");
    await refused.posted;
    await page
      .getByText(/^Not sent: bad-schema/)
      .first()
      .waitFor({ timeout: 10_000 });
    refuse = false;
    await needRow("Refused probe: merge?").first().click();
    await page
      .locator('section[aria-label="Selected"]')
      .getByRole("button", { name: /^Merge/ })
      .click();
    await refused.asked.waitFor(/Answer to d_\S+ \(Refused probe: merge\?\): Merge/);
    await page.unroute("**/v1/items");
    await page.unroute("**/v1/**");

    step("long options wrap on a phone's row instead of widening the page");
    const long = cli(
      "ask-long",
      [
        "ask",
        "--question",
        "Which inbox shot goes on the landing page?",
        "--option",
        "The dark inbox, because it shows the amber waiting rows best against the background",
        "--option",
        "The light inbox, because most visitors browse in light mode during the day",
        "--option",
        "Both, following the visitor's system theme",
        "--project",
        "starbridge",
        "--session",
        "e2e-long",
        "--wait",
      ],
      machineHome,
    );
    await long.waitFor(/^d_\S+$/m);
    await page
      .getByText("Which inbox shot goes on the landing page?")
      .first()
      .waitFor({ timeout: 30_000 });
    await shoot(page, "inbox-long-options");
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: /^Both, following/ })
      .first()
      .click();
    await long.waitFor(/Answer to d_\S+ .*: Both, following the visitor's system theme/);
    if ((await long.exited) !== 0) throw new Error("ask --wait for the long options failed");
    await page.setViewportSize(DESKTOP);

    step("images over their options share a height, so a phone's option buttons line up (#536)");
    {
      const LAYOUTS = "Which layout should the inbox lead with?";
      const picks = cli(
        "ask-picks",
        [
          "ask",
          "--question",
          LAYOUTS,
          "--option",
          "Desktop layout",
          "--option",
          "Phone layout",
          "--recommended",
          "Phone layout",
          "--image",
          image("a"),
          "--image",
          join(ROOT, "android/app/src/test/resources/fake/phone-inbox.png"),
          "--project",
          "starbridge",
          "--session",
          "e2e-picks",
          "--wait",
        ],
        machineHome,
      );
      const [picksId] = await picks.waitFor(/^d_\S+$/m);
      // A second open question, for J and K and the answer to move to (#1432).
      const after = cli(
        "ask-after",
        [
          "ask",
          ...["--question", "Tag the release once the picks land?"],
          ...["--option", "Tag it", "--option", "Wait"],
          ...["--project", "starbridge", "--session", "e2e-after"],
        ],
        machineHome,
      );
      const [afterId] = await after.waitFor(/^d_\S+$/m);
      await page.locator(`[data-row="${afterId}"]`).waitFor({ timeout: 30_000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .locator("[data-row]", { hasText: LAYOUTS })
        .first()
        .locator("button[data-id]")
        .click();
      await page.getByRole("heading", { name: LAYOUTS }).waitFor({ timeout: 30_000 });
      // Each image its own shape (no band), no wider than its button, both centred on one midline;
      // both buttons on one line.
      const rects = async (sel: string) =>
        page.locator(sel).evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            const img = e.querySelector("img");
            const shape = img ? img.naturalWidth / img.naturalHeight : 0;
            return {
              top: Math.round(r.top),
              middle: Math.round(r.top + r.height / 2),
              width: r.width,
              off: r.width / r.height - shape,
            };
          }),
        );
      await page.waitForFunction(() => {
        const imgs = [...document.querySelectorAll("fieldset img")] as HTMLImageElement[];
        return imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      });
      const images = await rects('fieldset button[aria-label^="View"]');
      const buttons = await rects('fieldset button:not([aria-label^="View"])');
      if (
        images.length !== 2 ||
        Math.abs(images[0].middle - images[1].middle) > 1 ||
        images.some((r, i) => Math.abs(r.off) > 0.02 || r.width > buttons[i].width + 0.5) ||
        buttons[0].top !== buttons[1].top
      )
        throw new Error(
          `the picks do not line up: images ${JSON.stringify(images)}, buttons ${JSON.stringify(buttons)}`,
        );
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.waitForTimeout(150);
        await fitsLayout(page, `picks ${scheme}`);
        await capture(page, join(SHOTS, `picks-phone-${scheme}.png`));
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
      // In place of the list, J and K open the next and previous card on the open card's history
      // entry, so Back still returns to the list (#1432).
      const openId = () => page.evaluate(() => new URLSearchParams(location.search).get("item"));
      const entries = await page.evaluate(() => history.length);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      let back = "k";
      await page.keyboard.press("j");
      if ((await openId()) === picksId) {
        back = "j";
        await page.keyboard.press("k");
      }
      const stepped = await openId();
      if (!stepped || stepped === picksId) throw new Error(`J and K under 1100 px open ${stepped}`);
      await page.getByRole("heading", { name: LAYOUTS }).waitFor({ state: "detached" });
      await page.keyboard.press(back);
      await page.getByRole("heading", { name: LAYOUTS }).waitFor();
      if ((await openId()) !== picksId || (await page.evaluate(() => history.length)) !== entries)
        throw new Error("J and K under 1100 px did not step back, or added history entries");
      // The reply field is open under the picks too (#849); in it, Shift+Enter starts a new line and
      // Enter sends (#562).
      const reply = page.getByRole("textbox", { name: "Your answer" });
      await replyClear(page, reply, () =>
        page.locator("[data-row]", { hasText: LAYOUTS }).first().locator("button[data-id]").click(),
      );
      // A pasted reply stops at the server's 4000 characters, as on Android (#1921).
      await reply.fill("x".repeat(4001));
      const capped = (await reply.inputValue()).length;
      if (capped !== 4000) throw new Error(`a 4001-character reply holds ${capped} characters`);
      await reply.fill("");
      await reply.pressSequentially("Phone layout");
      await reply.press("Shift+Enter");
      await reply.pressSequentially("on narrow screens");
      if ((await reply.inputValue()) !== "Phone layout\non narrow screens")
        throw new Error(
          `Shift+Enter did not start a new line: ${JSON.stringify(await reply.inputValue())}`,
        );
      // At Enter, before the server replies, the question goes (#895, #927). With a mouse the next
      // open card takes its place, and Back returns to the list without the question (#1432); a
      // touch screen goes straight back to the list (selection.test.ts).
      let release = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      await page.route("**/v1/items", async (route) => {
        if (route.request().method() === "POST") await held;
        await route.fallback();
      });
      await reply.press("Enter");
      await page.getByRole("heading", { name: LAYOUTS }).waitFor({ state: "detached" });
      const next = await openId();
      if (next !== afterId)
        throw new Error(`with a mouse, an answer under 1100 px opens ${next}, not the next card`);
      await page.goBack();
      await page.waitForFunction(() => location.search === "");
      await page.locator("button[data-id]").first().waitFor();
      const left = await page.locator("[data-row]", { hasText: LAYOUTS }).count();
      release();
      await page.unroute("**/v1/items");
      if (left > 0)
        throw new Error("the answered question is still listed while its reply is sent");
      await picks.waitFor(/Answer to d_\S+ .*: Phone layout/);
      if ((await picks.exited) !== 0) throw new Error("ask --wait for the picks failed");
      const withdraw = cli(
        "withdraw-after",
        ["settle", afterId as string, "--outcome", "withdrawn", "--reason", "Tagged by hand"],
        machineHome,
      );
      if ((await withdraw.exited) !== 0) throw new Error("settle --outcome withdrawn failed");
      await page.locator(`[data-row="${afterId}"]`).waitFor({ state: "detached", timeout: 30_000 });
      await page.setViewportSize(DESKTOP);
    }

    await leaveOpen();
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
    const row = page.locator("[data-row]:has(button[aria-current='true'])");
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
    step("the inbox list tells a screen reader what is selected, grouped and listed (#1942)");
    {
      const list = page.locator('section[aria-label="Inbox"]');
      // The selected row's own button says so; its wrapper does not repeat it.
      if ((await list.locator('button[aria-current="true"]').count()) !== 1)
        throw new Error("exactly one row's button should be aria-current");
      if ((await list.locator("li[aria-current]").count()) !== 0)
        throw new Error("a row's wrapper carries aria-current, where nothing can focus");
      const heads = await list.getByRole("heading", { level: 2 }).allInnerTexts();
      if (!heads.some((h) => h.startsWith("Needs you")))
        throw new Error(`no heading names the Needs you group: ${heads}`);
      // Every listed row is a list item, and the list names its items.
      const rows = await list
        .locator("[data-id]")
        .evaluateAll((buttons) => buttons.filter((b) => b.parentElement?.tagName !== "LI").length);
      const items = await list.getByRole("listitem").count();
      if (items === 0 || rows > 0) throw new Error(`${items} list items, ${rows} rows outside one`);
    }
    step("the inbox splitter shows an accent line on keyboard focus, not on hover (#1974)");
    {
      const edge = page.getByRole("separator", { name: "Inbox width" });
      const line = async () => {
        await page.waitForTimeout(400); // past the line's fade
        return edge.evaluate((el) => {
          const probe = document.createElement("i");
          probe.style.background = "var(--accent)";
          document.body.append(probe);
          const accent = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const c = getComputedStyle(el, "::after");
          return { color: c.backgroundColor, width: c.width, accent };
        });
      };
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.mouse.move(5, 5);
        await edge.hover();
        const hover = await line();
        if (hover.color === hover.accent || hover.width !== "3px")
          throw new Error(
            `${scheme}: hover gives ${JSON.stringify(hover)}, not the 3px neutral line`,
          );
        await page.mouse.move(5, 5);
        await page.keyboard.press("Tab");
        await edge.focus();
        if (!(await edge.evaluate((el) => el.matches(":focus-visible"))))
          throw new Error(`${scheme}: the splitter is not :focus-visible`);
        const focus = await line();
        if (focus.color !== focus.accent || focus.width !== "5px")
          throw new Error(
            `${scheme}: keyboard focus gives ${JSON.stringify(focus)}, not a 5px accent line`,
          );
        await edge.evaluate((el) => (el as HTMLElement).blur());
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    step("on a phone, Back closes an open question first; a reload and a link keep it (#347)");
    {
      const MERGE = "Merge #19 (server) before the web PR rebases?";
      const merge = await page
        .locator("[data-row]", { hasText: MERGE })
        .first()
        .getAttribute("data-row");
      const p = await a.newPage();
      await p.setViewportSize({ width: 390, height: 844 });
      const where = () => new URL(p.url()).pathname + new URL(p.url()).search;
      const expectAt = async (path: string, showing: "list" | "detail", what: string) => {
        await p
          .waitForURL((u) => u.pathname + u.search === path, { timeout: 10_000 })
          .catch(() => {});
        const back = p.getByRole("button", { name: "Back", exact: true });
        const open = (await back.count()) > 0;
        if (where() !== path || open !== (showing === "detail"))
          throw new Error(`${what}: at ${where()} showing the ${open ? "detail" : "list"}`);
      };
      await p.goto(`${ORIGIN}/quotas`);
      await p
        .getByRole("link", { name: /^Inbox/ })
        .first()
        .click();
      await p.locator(`button[data-id="${merge}"]`).click();
      await expectAt(`/?item=${merge}`, "detail", "a tapped question");
      await p.getByRole("heading", { name: MERGE }).waitFor();
      await p.goBack();
      await expectAt("/", "list", "Back from the open question");
      // The in-page way back steps back through history, so it leaves no entry behind; a quick
      // second tap does not step back twice.
      await p.locator(`button[data-id="${merge}"]`).click();
      await expectAt(`/?item=${merge}`, "detail", "the question tapped again");
      await p.getByRole("button", { name: "Back", exact: true }).dblclick();
      await expectAt("/", "list", "a double tap on the in-page Back");
      await p.goBack();
      await expectAt("/quotas", "list", "Back from the inbox");
      await p.goForward();
      await p.goForward();
      await expectAt(`/?item=${merge}`, "detail", "Forward to the question");
      await p.reload();
      await p.getByRole("heading", { name: MERGE }).waitFor({ timeout: 30_000 });
      await expectAt(`/?item=${merge}`, "detail", "a reload with the question open");
      await p.getByRole("button", { name: "Back", exact: true }).click();
      await expectAt("/", "list", "the in-page Back after a reload");
      await p.goBack();
      await expectAt("/quotas", "list", "Back after the in-page Back");

      // A window widened with the question open selects it beside the list, one step back.
      await p.goForward();
      await expectAt("/", "list", "Forward to the inbox");
      await p.locator(`button[data-id="${merge}"]`).click();
      await expectAt(`/?item=${merge}`, "detail", "the question tapped before widening");
      await p.setViewportSize(DESKTOP);
      const selected = p.locator('section[aria-label="Selected"] h2');
      await p.waitForURL((u) => u.pathname === "/" && u.search === "", { timeout: 10_000 });
      if ((await selected.innerText()) !== MERGE)
        throw new Error(`a widened window selects "${await selected.innerText()}"`);
      await p.goBack();
      await p.waitForURL((u) => u.pathname === "/quotas", { timeout: 10_000 });

      // A link opens the question, and Back from it returns to the list, not out of the app.
      await p.setViewportSize({ width: 390, height: 844 });
      await p.goto(`${ORIGIN}/?item=${merge}`);
      await p.getByRole("heading", { name: MERGE }).waitFor({ timeout: 30_000 });
      await p.goBack();
      await expectAt("/", "list", "Back from a linked question");
      // A link to an item this inbox no longer has says it was answered, once it has looked.
      await p.goto(`${ORIGIN}/?item=d_gone`);
      await p.getByText("Answered", { exact: true }).waitFor({ timeout: 30_000 });

      // A desktop window selects a linked item beside the list and adds no history entry for
      // it or for a pick.
      await p.setViewportSize(DESKTOP);
      await p.goto(`${ORIGIN}/?item=${merge}`);
      await p.waitForURL((u) => u.pathname === "/" && u.search === "", { timeout: 30_000 });
      await selected.filter({ hasText: MERGE }).waitFor();
      const entries = await p.evaluate(() => history.length);
      const closed = (await p.locator("button[data-id]").count()) < 2;
      if (closed) await p.getByRole("button", { name: /History/ }).click();
      await p.locator(`button[data-id]:not([data-id="${merge}"])`).first().click();
      await p.waitForFunction(
        (q) => document.querySelector('section[aria-label="Selected"] h2')?.textContent !== q,
        MERGE,
      );
      if ((await p.evaluate(() => history.length)) !== entries || where() !== "/")
        throw new Error(`picking on a desktop moved history: at ${where()}`);
      // The next steps expect History as they left it.
      if (closed) await p.getByRole("button", { name: /History/ }).click();
      await p.close();
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
    const pointer = cli(
      "pointer",
      [
        ...["ask", "--question", "Which of the three settings layouts should ship?"],
        ...[
          "--context",
          "Each layout is live in the artifact. Its buttons send your pick to the session.",
        ],
        ...["--answer-in", ARTIFACT],
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
    if ((await answerIn.getAttribute("href")) !== ARTIFACT)
      throw new Error("the decision does not link the artifact it is answered in");
    if ((await pane.locator("fieldset, textarea").count()) > 0)
      throw new Error("a decision answered in an artifact also offers an answer here");
    // "Settings screen (#88)" is cut as "Settings " and "screen (#88)".
    await keepsSessionSpace(page, "the artifact decision");
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

    step("a withdrawn decision shows the agent's reason in History (#1008)");
    // Every time a status line takes the text, so a repeat the page does not re-announce shows.
    await page.evaluate(() => {
      const heard: string[] = [];
      (window as unknown as { heard: string[] }).heard = heard;
      new MutationObserver((records) => {
        const seen = new Set<Element>();
        for (const r of records) {
          const el = (r.target instanceof Element ? r.target : r.target.parentElement)?.closest(
            '[role="status"]',
          );
          if (el?.textContent && !seen.has(el)) {
            seen.add(el);
            heard.push(el.textContent);
          }
        }
      }).observe(document.body, { childList: true, characterData: true, subtree: true });
    });
    const heardCount = (text: RegExp) =>
      page.evaluate(
        ([src]) =>
          (window as unknown as { heard: string[] }).heard.filter((x) => new RegExp(src).test(x))
            .length,
        [text.source],
      );
    const retry = [
      ...["ask", "--question", "Retry the flaky upload test?", "--option", "Retry"],
      ...["--option", "Skip", "--project", "starbridge"],
    ];
    const moot = cli("moot", retry, machineHome);
    const [mootId] = await moot.waitFor(/d_[\w-]+/);
    if ((await moot.exited) !== 0) throw new Error("ask failed");
    // A question arriving in an open page is announced by a polite status (#1942).
    const retried = /^New question from .*: Retry the flaky upload test\?$/;
    await page
      .getByRole("status")
      .filter({ hasText: retried })
      .waitFor({ state: "attached", timeout: 30_000 });

    step("the same announcement twice in a row is read out again (#1942)");
    const repeated = cli("repeated", retry, machineHome);
    const [againId] = await repeated.waitFor(/d_[\w-]+/);
    for (let i = 0; i < 60 && (await heardCount(retried)) < 2; i++) await page.waitForTimeout(500);
    if ((await heardCount(retried)) < 2)
      throw new Error("a repeated announcement did not reach the status line again");
    step("the status line is announced with a question open on a narrow screen (#1942)");
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .locator("button[data-id]")
      .nth(3)
      .click({ position: { x: 80, y: 12 } });
    await page.getByRole("button", { name: /Back/ }).waitFor();
    const narrow = cli(
      "narrow",
      [
        "ask",
        "--question",
        "Is the narrow status mounted?",
        "--option",
        "Yes",
        "--option",
        "No",
        "--project",
        "starbridge",
      ],
      machineHome,
    );
    const [narrowId] = await narrow.waitFor(/d_[\w-]+/);
    await page
      .getByRole("status")
      .filter({ hasText: /^New question from .*: Is the narrow status mounted\?$/ })
      .waitFor({ state: "attached", timeout: 30_000 });
    await page.setViewportSize(DESKTOP);

    for (const id of [narrowId, againId])
      if (
        (await cli(
          "close",
          ["settle", id as string, "--outcome", "withdrawn", "--reason", "Asked to test"],
          machineHome,
        ).exited) !== 0
      )
        throw new Error("settle --outcome withdrawn failed");
    const reason = "Fixed it myself after rereading the logs";
    const withdraw = cli(
      "withdraw",
      ["settle", mootId as string, "--outcome", "withdrawn", "--reason", reason],
      machineHome,
    );
    if ((await withdraw.exited) !== 0) throw new Error("settle --outcome withdrawn failed");
    await page
      .locator(`[data-id="${mootId}"]`)
      .locator("..")
      .getByText(`Withdrawn · ${reason}`)
      .waitFor({ timeout: 30_000 });

    await page.getByRole("link", { name: "Quotas" }).click();
    await page.locator("article").first().waitFor();
    await shoot(page, "quotas");

    step("the refresh button asks the machines for fresh quotas, as Android's pull to refresh");
    await page.setViewportSize(DESKTOP);
    const refresh = page.getByRole("button", { name: "Refresh quotas" }).filter({ visible: true });
    const asked = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().includes("/quota/ask"),
    );
    await refresh.click();
    await asked;
    // No agent runs in this test, so the server holds the ask its 25 s before it answers.
    await page.waitForSelector('button[aria-label="Refresh quotas"][aria-busy="false"]:visible', {
      timeout: 40_000,
    });

    step("quota settings: remaining, clock times, workdays");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("heading", { name: "Settings" }).waitFor();
    for (const label of ["Left", "Resets 14:20", "5"]) await choose(page, label);
    await shoot(page, "settings");

    step("settings: each radio group is one group to the keyboard (#1941)");
    const groups = page.getByRole("radiogroup");
    const names = new Set<string>();
    for (const group of await groups.all()) {
      const named = await group
        .locator('input[type="radio"]')
        .evaluateAll((radios) => radios.map((r) => (r as HTMLInputElement).name));
      if (named.some((n) => n === "" || n !== named[0]))
        throw new Error(`a radio group's radios do not share one name: ${named.join(", ")}`);
      if (names.has(named[0])) throw new Error(`two radio groups share the name ${named[0]}`);
      names.add(named[0]);
    }
    // Arrows move and pick within a group; the next one returns it to what it was.
    const sound = groups.filter({ has: page.getByLabel("Left", { exact: true }) });
    const was = await sound
      .locator(":checked")
      .evaluate((r) => (r as HTMLInputElement).labels?.[0]?.textContent);
    await sound.locator(":checked").focus();
    await page.keyboard.press("ArrowRight");
    const moved = await sound
      .locator(":checked")
      .evaluate((r) => (r as HTMLInputElement).labels?.[0]?.textContent);
    await page.keyboard.press("ArrowLeft");
    const back = await sound
      .locator(":checked")
      .evaluate((r) => (r as HTMLInputElement).labels?.[0]?.textContent);
    if (moved === was || back !== was)
      throw new Error(`arrows in a radio group: was ${was}, moved to ${moved}, back to ${back}`);

    step("the Version row shows the build's version and copies it (#1892)");
    const version = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")).version;
    const versionRow = page.getByRole("button", { name: /^Version / });
    await versionRow.scrollIntoViewIfNeeded();
    if (!(await versionRow.innerText()).includes(version))
      throw new Error(`the Version row does not show ${version}`);
    await shoot(page, "settings-version");
    // The account section at a phone's width, at rest and within the 1.5 s the value reads Copied.
    await page.setViewportSize({ width: 390, height: 800 });
    const account = page.getByRole("region", { name: "Account" });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await account.scrollIntoViewIfNeeded();
      await versionRow.getByText(version).waitFor();
      await capture(account, join(AUDIT ?? SHOTS, `settings-version-row-${scheme}.png`));
      await versionRow.click();
      await versionRow.getByText("Copied").waitFor();
      await capture(account, join(AUDIT ?? SHOTS, `settings-version-copied-${scheme}.png`));
      await versionRow.getByText(version).waitFor();
    }
    await page.setViewportSize(DESKTOP);
    await versionRow.getByText(version).waitFor();
    await page.getByRole("link", { name: "Quotas" }).click();
    await page.locator("article").first().waitFor();
    if (!(await page.locator("article").first().innerText()).includes("% left"))
      throw new Error("the bars do not show what is left");
    await shoot(page, "quotas-tuned");

    step("a group pinned by running out first says why on a click (#296)");
    await page.setViewportSize(DESKTOP);
    await page.getByRole("button", { name: "Why codex is up top" }).click();
    // Scoped to codex: depending on the hour, claude's group may be pinned too.
    const why = page.getByRole("region", { name: "codex" }).getByText(/^Up top because it/);
    await why.waitFor();
    if (AUDIT) await shoot(page, "quotas-pinned");
    else
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(150);
        await capture(page, join(SHOTS, `quotas-pinned-${scheme}.png`));
      }
    await page.keyboard.press("Escape");
    await why.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Why codex is up top" }).click();
    await why.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(/\/settings#running-out-first$/);
    await page.getByRole("switch", { name: "Running out first" }).waitFor();
    const inView = await page.locator("#running-out-first").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    });
    if (!inView) throw new Error("the pin's Settings link does not scroll to the setting");

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
    await choose(page, "24-hour");
    await shoot(page, "settings-clock");

    step(
      "keyboard shortcuts: ? opens the dialog outside a field, Esc closes it, a short window scrolls it (#1889)",
    );
    const keys = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await page.getByRole("heading", { name: "Settings", level: 1 }).click();
    await page.keyboard.press("?");
    await keys.waitFor();
    await page.keyboard.press("Escape");
    await keys.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await keys.waitFor();
    await shoot(page, "settings-keys");
    await page.setViewportSize({ width: 1280, height: 420 });
    const last = keys.getByRole("region", { name: "Help" });
    await last.scrollIntoViewIfNeeded();
    const within = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    };
    if (!(await keys.evaluate(within)))
      throw new Error("the shortcuts dialog overflows a short window");
    if (!(await last.evaluate(within))) throw new Error("a short window cut off the last group");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(150);
      await capture(page, join(SHOTS, `settings-keys-short-${scheme}.png`));
    }
    await page.setViewportSize(DESKTOP);
    await page.keyboard.press("Escape");
    await keys.waitFor({ state: "hidden" });
    // Typing a question mark into Find is not a shortcut.
    await page.getByRole("textbox", { name: "Find" }).fill("?");
    if (await keys.isVisible()) throw new Error("? in a field opened the dialog");
    await page.getByRole("textbox", { name: "Find" }).fill("");
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
    // 12-hour times are the longest: "Will run out on Oct 12 at 12:02 AM".
    await choose(page, "12-hour");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("link", { name: /^Inbox/ }).click();
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
      await capture(page, join(AUDIT ?? SHOTS, `inbox-aside-wide-${scheme}.png`));
    }

    step("a newly raised quota alert notifies a browser that picked it for its window");
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
    await page.getByRole("checkbox", { name: /^e2e .*: 20% left$/ }).check();
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

    step(
      "a failed probe keeps the last windows, stale; with none to keep, a short error (#397, #450)",
    );
    const timedOut = [
      { provider: "e2e", source: "auto", error: { message: "Claude usage probe timed out." } },
      {
        provider: "e2e2",
        source: "web",
        error: { message: 'Mistral API error: HTTP 500: {"detail":"Internal server error"}' },
      },
    ];
    writeFileSync(fakeBar, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(timedOut)}\nEOF\nexit 1\n`);
    const failedPush = cli(
      "quota-failed",
      ["quota", "push", "--once", "--codexbar", fakeBar, "--provider", "e2e", "--provider", "e2e2"],
      machineHome,
    );
    if ((await failedPush.exited) !== 0) throw new Error("quota push failed");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("link", { name: "Quotas" }).click();
    const group = page.getByRole("region", { name: "e2e", exact: true });
    await group.getByText("Claude usage probe timed out.").waitFor();
    await group.getByText(/^Updated /).waitFor();
    if ((await group.getByRole("article").count()) === 0)
      throw new Error("the failed provider lost its windows");
    if ((await page.getByText(/^e2e2? on /).count()) > 0)
      throw new Error("the failure shows as a line above the table");
    const empty = page.getByRole("region", { name: "e2e2", exact: true });
    await empty.getByText("Mistral's usage API failed (500)").waitFor();
    if ((await page.getByText("Internal server error").count()) > 0)
      throw new Error("the provider's raw error reached the page");
    await shoot(page, "quotas-failed");

    step("the Quotas table fits its longest reset times, phone to desktop (#294)");
    // Local clock times: "tomorrow 21:59", "tomorrow 12:59 PM" and a date five days out.
    const local = (days: number, h: number, m: number) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(h, m, 0, 0);
      return d.toISOString().replace(/\.\d+Z$/, "Z");
    };
    dataNow = Date.now();
    const longResets = [
      {
        provider: "e2e",
        source: "api",
        usage: {
          updatedAt: at(0),
          primary: { windowMinutes: 10080, usedPercent: 22, resetsAt: local(1, 21, 59) },
          secondary: { windowMinutes: 10080, usedPercent: 40, resetsAt: local(1, 12, 59) },
          tertiary: { windowMinutes: 10080, usedPercent: 10, resetsAt: local(5, 22, 59) },
        },
      },
    ];
    writeFileSync(fakeBar, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(longResets)}\nEOF\n`);
    const longPush = cli(
      "quota-long",
      ["quota", "push", "--once", "--codexbar", fakeBar, "--provider", "e2e"],
      machineHome,
    );
    if ((await longPush.exited) !== 0) throw new Error("quota push failed");
    for (const clock of ["24-hour", "12-hour"] as const) {
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "Settings" })
        .click();
      await choose(page, clock);
      await page.getByRole("link", { name: "Quotas" }).click();
      const resets = page.locator("article span", { hasText: /^tomorrow \d/ });
      await resets.first().waitFor();
      if (AUDIT) await shoot(page, `quotas-long-resets-${clock}`);
      for (const [size, viewport] of [
        ["desktop", { width: 1440, height: 900 }],
        // About the narrowest window with the table, where its columns are at their minimums.
        ["table-edge", { width: 1210, height: 900 }],
        ["phone", { width: 390, height: 844 }],
      ] as const) {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: "light" });
        await page.waitForTimeout(150);
        await capture(
          page,
          join(AUDIT ?? SHOTS, `quotas-long-resets-${clock}-${size}.png`),
          size !== "phone",
        );
        await fitsLayout(page, "quotas");
        for (const cell of await resets.all()) {
          const { text, scroll, client, lines } = await cell.evaluate((el) => ({
            text: el.textContent,
            scroll: el.scrollWidth,
            client: el.clientWidth,
            lines: (() => {
              const r = document.createRange();
              r.selectNodeContents(el);
              return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
            })(),
          }));
          if (scroll > client || lines > 1)
            throw new Error(
              `"${text}" overflows its cell at ${viewport.width} px: ${scroll} > ${client} px, ${lines} lines`,
            );
        }
      }
    }

    step("worst-case content: long names, unbroken words, many items, a prompt and a run");
    await page.setViewportSize(DESKTOP);
    const farHome = join(tmp, "far");
    const MACHINE = "build-runner-in-the-basement-rack-02.internal.example.org";
    const PROJECT = "a-monorepo-whose-name-runs-on-past-any-column";
    const farPair = cli("pair-far", ["pair", "--name", MACHINE], farHome);
    const farCode = (await farPair.waitFor(/Pairing code: (\S+)/))[1] as string;
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await follow(page, page.getByRole("link", { name: "Add a device" }), "/settings/devices/add");
    await page.getByLabel("Pair a machine or device").fill(farCode);
    await page.getByRole("button", { name: "Check code" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await confirmCheck(page, farPair, "pair-far", farHome);
    if ((await farPair.exited) !== 0) throw new Error("pair of the long-named machine failed");
    // The audit also shoots device names of about 10, 25, 40 and 70 characters, with and without
    // dots and hyphens, to see where each breaks in Settings: three at a time, as an account
    // holds at most five machines, each batch revoked before the next.
    const NAMES = [
      "mac-studio",
      "buildhost7",
      "runner02.eu-west.example",
      "Tomsmacbookprofromtheoffice",
      "runner02.eu-west.internal.example.org",
      "buildrunnerinthebasementrackzerotwoeuwest",
      "build-runner-in-the-basement-rack-02.ci.internal.example-company.org",
      "averyveryverylongmachinenamewithnobreaksatallthatkeepsongoingforseventy",
    ];
    for (let b = 0; AUDIT && b < NAMES.length; b += 3) {
      const batch = NAMES.slice(b, b + 3);
      for (const name of batch) {
        const home = join(tmp, `name-${name}`);
        const pair = cli(`pair-${name}`, ["pair", "--name", name], home);
        const code = (await pair.waitFor(/Pairing code: (\S+)/))[1] as string;
        await page.getByLabel("Pair a machine or device").fill(code);
        await page.getByRole("button", { name: "Check code" }).click();
        await page.getByText(`Let ${name} post decisions and quotas?`).waitFor();
        await page.getByRole("button", { name: "Approve" }).click();
        await confirmCheck(page, pair, `pair-${name}`, home);
        if ((await pair.exited) !== 0) throw new Error(`pair of ${name} failed`);
      }
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "Settings" })
        .click();
      const devices = page.getByRole("region", { name: "Devices" });
      await devices.getByText(batch.at(-1) as string).waitFor();
      await shoot(page, `settings-names-${b / 3 + 1}`);
      for (const name of batch) {
        await devices
          .getByTestId("device")
          .filter({ hasText: name })
          .getByRole("button", { name: "Revoke" })
          .click();
        await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
      }
      await follow(page, page.getByRole("link", { name: "Add a device" }), "/settings/devices/add");
    }
    if ((await cli("perm-on", ["config", "permissions", "on"], farHome).exited) !== 0)
      throw new Error("config permissions on failed");
    const farQuota = cli(
      "quota-far",
      ["quota", "push", "--once", "--codexbar", fakeBar, "--provider", "e2e"],
      farHome,
    );
    if ((await farQuota.exited) !== 0)
      throw new Error("quota push from the long-named machine failed");
    const BRANCH = "refs/heads/t/rename-every-provider-id-to-codexbar-names-and-keep-aliases";
    for (let i = 1; i <= 24; i++) {
      const asked = cli(
        `ask-many-${i}`,
        [
          "ask",
          "--question",
          i % 3
            ? `Question ${i}: rebase ${BRANCH} onto main and force-push it before the reviewers wake up, or wait for their pass on the old base first?`
            : `Ship ${i}?`,
          ...(i % 4 === 0
            ? [
                "--context",
                `See ${BRANCH} and https://github.com/T0mSIlver/starbridge/pull/${i}/files#diff-${"0123456789abcdef".repeat(4)}`,
              ]
            : []),
          "--option",
          i % 2 ? "Rebase and force-push now, then ask the reviewers again in the morning" : "Yes",
          "--option",
          i % 2 ? `Wait for ${BRANCH}` : "No",
          ...(i % 5 === 0 ? ["--waiting"] : []),
          "--project",
          PROJECT,
          "--session",
          `worst-case-session-${i}-${"x".repeat(40)}`,
          "--session-title",
          `Rename every provider id to CodexBar's names and keep the old ones as aliases (${i})`,
        ],
        i % 2 ? farHome : machineHome,
      );
      if ((await asked.exited) !== 0) throw new Error(`ask ${i} failed`);
    }
    const prompt = spawn(
      "bun",
      ["run", join(ROOT, "cli/src/main.ts"), "hook", "permission", "--agent", "claude-code"],
      {
        env: {
          ...machineEnv(),
          STARBRIDGE_CONFIG_DIR: farHome,
          STARBRIDGE_SERVER: `http://localhost:${PORTS.server}`,
        },
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
    children.push(prompt);
    prompt.on("exit", (code) => {
      if (!prompt.killed) console.log(`[prompt] exited ${code} before it was answered`);
    });
    prompt.stdin?.end(
      JSON.stringify({
        session_id: "worst-case-prompt",
        cwd: `/home/me/work/${PROJECT}`,
        tool_name: "Bash",
        tool_input: {
          command: `git push --force-with-lease origin ${BRANCH} && gh pr edit 305 --body-file /home/me/work/${PROJECT}/.scratch/pr-body-with-a-long-name.md`,
        },
      }),
    );
    const longRun = cli(
      "run-long",
      [
        ...["run", "--title", `Nightly eval of every provider on ${MACHINE}`],
        ...["--reason", `Checks ${BRANCH} against the recorded answers`, "--", "sleep", "600"],
      ],
      farHome,
    );
    await page.getByRole("link", { name: /^Inbox/ }).click();
    await page.locator("button[data-id]").nth(24).waitFor({ timeout: 30_000 });
    await page
      .getByText(/^Nightly eval/)
      .first()
      .waitFor({ timeout: 30_000 });
    await page
      .getByText(/^git push --force-with-lease/)
      .first()
      .waitFor({ timeout: 30_000 });
    await shoot(page, "inbox-full");
    for (const [view, name] of [
      ["Group by machine", "inbox-by-machine"],
      ["Group by waiting", "inbox-by-waiting"],
      ["One feed", ""],
    ] as const) {
      await page.getByRole("button", { name: "Group by", exact: true }).click();
      await page.getByRole("menuitemradio", { name: view }).click();
      if (name) await shoot(page, name);
    }
    await page.getByRole("button", { name: /History/ }).click();
    await shoot(page, "inbox-history");
    await page.getByRole("button", { name: /History/ }).click();
    await page
      .getByRole("button", { name: /^Waiting for you.*git push/ })
      .first()
      .click();
    await shoot(page, "inbox-prompt");
    await page.setViewportSize({ width: 390, height: 844 });
    // A phone's row carries its options; its meta line opens it.
    await page
      .locator("button[data-id]")
      .nth(3)
      .click({ position: { x: 80, y: 12 } });
    await page.getByRole("button", { name: /Back/ }).waitFor();
    await shoot(page, "inbox-detail");
    await page.setViewportSize(DESKTOP);
    await page.getByLabel("Find").fill("rebase");
    await shoot(page, "inbox-search");
    await page.getByLabel("Find").fill("");
    step("a prompt already open when the page loads is not announced (#1942)");
    // The prompts come back after the questions, as they do on a slow link.
    const slowPrompts = async (route: Route) => {
      await new Promise((done) => setTimeout(done, 2_000));
      await route.fallback();
    };
    await page.route(/\/v1\/items\?kind=permission&open=1/, slowPrompts);
    await page.reload();
    await page
      .getByText(/^git push --force-with-lease/)
      .first()
      .waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const early = await page.getByRole("status").allTextContents();
    if (early.some((x) => /^(New |\d+ new )/.test(x)))
      throw new Error(`a prompt listed at load was announced: ${early.join(" | ")}`);
    await page.unroute(/\/v1\/items\?kind=permission&open=1/, slowPrompts);
    await page.getByRole("link", { name: "Quotas" }).click();
    await page.locator("article").first().waitFor();
    await shoot(page, "quotas-machines");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("heading", { name: "Settings" }).waitFor();
    await shoot(page, "settings-full");
    prompt.kill();
    longRun.proc.kill();
    await loadBudget(page);
  }
  if (SHARD === "inbox") return;

  step("add a second browser by pairing code");
  const b = await context({ permissions: ["notifications"] });
  await watchCsp(b);
  const pageB = await signIn(b);
  await pageB.getByTestId("pairing-code").waitFor({ timeout: 10_000 });
  await shoot(pageB, "join-browser");
  // Switching to digits cancels the QR code's wait; that cancel shows no error.
  await pageB.getByRole("button", { name: "Can't scan? Compare digits" }).click();
  await pageB.getByText(/Open Starbridge on a device you already use/).waitFor();
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
  // The first browser's window can cover this one, and Firefox stops a covered window's
  // animation frames, which a click waits on.
  await pageB.bringToFront();
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
  await follow(page, page.getByRole("link", { name: "Add a device" }), "/settings/devices/add");
  await page.getByLabel("Pair a machine or device").fill(codeB);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByText(/read and answer as a device/).waitFor();
  await page.getByRole("button", { name: "Approve" }).click();
  await pageB.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  await pageB.getByRole("button", { name: "Turn on notifications" }).waitFor();
  await shoot(pageB, "inbox-banner");
  // The new device sees decisions sealed after it joined; the open one predates it.

  if (runs("devices")) {
    step("two browsers answer at once: the one that loses says which answer won (#330)");
    const race = cli(
      "race",
      [
        ...["ask", "--question", "Race probe: rotate now?", "--option", "Rotate"],
        ...["--option", "Later", "--project", "starbridge", "--session", "e2e", "--wait"],
      ],
      machineHome,
    );
    await race.waitFor(/^d_\S+$/m);
    await page.goto(ORIGIN);
    await pageB.reload();
    // Other questions may be open: select this one on both.
    for (const p of [page, pageB])
      await p
        .getByRole("button", { name: /Race probe: rotate now\?$/ })
        .first()
        .click({ timeout: 30_000 });
    const later = selected(page).getByRole("button", { name: /^Later/ });
    const rotate = selected(pageB).getByRole("button", { name: /^Rotate/ });
    await later.waitFor({ timeout: 30_000 });
    await rotate.waitFor({ timeout: 30_000 });
    await later.click();
    await race.waitFor(/Answer to d_\S+ \(Race probe: rotate now\?\): Later/);
    if ((await race.exited) !== 0) throw new Error("ask --wait failed");
    // The second browser has not read the inbox since: its answer reaches the server second, and
    // the machine's settled notice tells it which answer won.
    await rotate.click();
    await pageB.getByText(/^Answered on .+: Later$/).waitFor({ timeout: 30_000 });
    await pageB.getByText(/^Later · on /).waitFor();

    step(
      "Runs close and stay closed, still naming a failure; Dismiss drops a run on both browsers (#835, #827)",
    );
    const failing = cli(
      "run-fails",
      ["run", "--title", "Dismiss probe", "--reason", "fails at once", "--", "sh", "-c", "exit 3"],
      machineHome,
    );
    if ((await failing.exited) !== 3)
      throw new Error("starbridge run should exit with its command");
    await page.goto(ORIGIN);
    await pageB.reload();
    const runProbe = (p: typeof page) => p.getByRole("article", { name: "Dismiss probe" });
    await runProbe(page).waitFor({ timeout: 30_000 });
    await runProbe(pageB).waitFor({ timeout: 30_000 });
    const runsHead = page.getByRole("button", { name: /^Runs/ });
    if ((await runsHead.getAttribute("aria-expanded")) !== "true")
      throw new Error("Runs should start open");
    await runsHead.click();
    await runProbe(page).waitFor({ state: "detached" });
    await page.waitForTimeout(800);
    if ((await runsHead.count()) !== 1) throw new Error("closing Runs took its head (#1824)");
    await page.reload();
    await runsHead.getByText(/failed$/).waitFor({ timeout: 30_000 });
    if ((await runsHead.getAttribute("aria-expanded")) !== "false")
      throw new Error("Runs should stay closed");
    await runsHead.click();
    await runProbe(page).getByRole("button", { name: "Dismiss Dismiss probe" }).click();
    await runProbe(page).waitFor({ state: "detached" });
    // The second browser reads runs every 10 s.
    await runProbe(pageB).waitFor({ state: "detached", timeout: 30_000 });

    step(
      "Done on one browser closes a question answered in an artifact on the other, and tells the agent (#539)",
    );
    const doneAsk = cli(
      "done",
      [
        ...["ask", "--question", "Done probe: which layout?", "--answer-in", ARTIFACT],
        ...["--project", "starbridge", "--session", "e2e"],
      ],
      machineHome,
    );
    const [doneId] = await doneAsk.waitFor(/d_[\w-]+/);
    if ((await doneAsk.exited) !== 0) throw new Error("ask --answer-in failed");
    const doneWait = cli("done-wait", ["wait", doneId as string, "--timeout", "60s"], machineHome);
    await page.goto(ORIGIN);
    await pageB.reload();
    await pageB.locator(`button[data-id="${doneId}"]`).click({ timeout: 30_000 });
    await selected(pageB).getByRole("button", { name: "Done", exact: true }).click();
    await doneWait.waitFor(
      /Answer to d_\S+ \(Done probe: which layout\?\): answered on its page; read the answer there/,
    );
    if ((await doneWait.exited) !== 0) throw new Error("wait for the Done failed");
    // The first browser hears by Web Push, without a reload, and the machine's notice names the
    // second. History lists only closed questions, and stays open once opened.
    const historyHead = page.getByRole("button", { name: /History/ });
    await historyHead.waitFor();
    if ((await historyHead.getAttribute("aria-expanded")) !== "true") await historyHead.click();
    await page
      .locator(`[data-id="${doneId}"]`)
      .locator("..")
      .getByText(/Answered in the artifact · on /)
      .waitFor({ timeout: 30_000 });
  }

  // Chrome can settle requestPermission as "default" while its prompt waits folded into a chip in
  // the address bar; Allow there comes after the click and still turns push on (#1030).
  const notifyB = async () => {
    step("the second browser turns on notifications while its prompt waits (#1030)");
    await pageB.evaluate(() => {
      const status = Object.assign(new EventTarget(), { state: "prompt" as PermissionState });
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d.name === "notifications"
          ? Promise.resolve(status as unknown as PermissionStatus)
          : query(d);
      const ask = Notification.requestPermission;
      const w = window as unknown as { asked?: boolean; listening?: boolean; allow: () => void };
      Notification.requestPermission = () => {
        w.asked = true;
        return Promise.resolve("default");
      };
      const listen = status.addEventListener.bind(status);
      status.addEventListener = (...a: Parameters<EventTarget["addEventListener"]>) => {
        w.listening = true;
        listen(...a);
      };
      w.allow = () => {
        Notification.requestPermission = ask;
        status.state = "granted";
        status.dispatchEvent(new Event("change"));
      };
    });
    await pageB.getByRole("button", { name: "Turn on notifications" }).click();
    await pageB.waitForFunction(() => {
      const w = window as unknown as { asked?: boolean; listening?: boolean };
      return w.asked && w.listening;
    });
    if (!(await pageB.getByRole("button", { name: "Turn on notifications" }).isVisible()))
      throw new Error("expected the banner to stay while the browser's prompt is unanswered");
    await pageB.evaluate(() => (window as unknown as { allow: () => void }).allow());
    await pageB
      .getByRole("button", { name: "Turn on notifications" })
      .waitFor({ state: "detached" });
  };

  if (runs("snooze")) {
    step(
      "snooze on one browser: it leaves both inboxes, wait says until when, and at its time it comes back with one notification (#571)",
    );
    await notifyB();
    const snoozeAsk = cli(
      "snooze-ask",
      [
        ...["ask", "--question", "Snooze probe: ship the docs?", "--option", "Ship"],
        ...["--option", "Hold", "--project", "starbridge", "--session", "e2e"],
      ],
      machineHome,
    );
    const [snoozeId] = await snoozeAsk.waitFor(/d_[\w-]+/);
    if ((await snoozeAsk.exited) !== 0) throw new Error("ask for the snooze probe failed");
    const probe = (p: Page) => p.locator(`button[data-id="${snoozeId}"]`);
    const probes = async (p: Page) =>
      ((await p.evaluate(NOTIFICATIONS)) as { title: string; body: string }[]).filter((n) =>
        n.title.startsWith("Snooze probe"),
      );
    for (let i = 0; i < 50 && (await probes(pageB)).length === 0; i++)
      await pageB.waitForTimeout(200);
    if ((await probes(pageB)).length !== 1) throw new Error("no notification for the snooze probe");
    // The second browser snoozes, since the first one's push subscription may be gone by now
    // (Firefox drops one that got many quiet pushes). Its clock runs 58 minutes behind, so its
    // "1 hour" ends 2 minutes from now, and the server checks snoozes every 15 s.
    const SHIFT = 58 * 60_000;
    await pageB.clock.install({ time: new Date(Date.now() - SHIFT) });
    await pageB.goto(ORIGIN);
    await probe(pageB).click({ timeout: 30_000 });
    step("on a phone's width the Snooze times stay inside the window (#1995)");
    const wide = pageB.viewportSize();
    for (const width of [360, 390]) {
      await pageB.setViewportSize({ width, height: 800 });
      const snooze = pageB.getByRole("button", { name: "Snooze", exact: true });
      if (!(await snooze.count())) await probe(pageB).click();
      await snooze.click();
      const times = await pageB.getByRole("dialog", { name: "Snooze until" }).boundingBox();
      if (!times || times.x < 0 || times.x + times.width > width)
        throw new Error(
          `the Snooze times run past the window at ${width} px: ${JSON.stringify(times)}`,
        );
      await pageB.keyboard.press("Escape");
    }
    if (wide) await pageB.setViewportSize(wide);
    if (!(await selected(pageB).count())) await probe(pageB).click();
    const opener = selected(pageB).getByRole("button", { name: "Snooze", exact: true });
    step("Esc closes Snooze's times and focus returns to its button (#1943)");
    await opener.click();
    await pageB.getByRole("dialog", { name: "Snooze until" }).waitFor();
    await pageB.keyboard.press("Escape");
    await pageB.getByRole("dialog", { name: "Snooze until" }).waitFor({ state: "detached" });
    if (!(await opener.evaluate((b) => b === document.activeElement)))
      throw new Error("focus did not return to the Snooze button after Esc");
    // Picked from the keyboard, as Esc: the card and its Snooze button leave, so focus goes to the
    // next question's row, else to the Snoozed head, never to the page. Nothing else is open here.
    step("picking a snooze time moves focus to the inbox list, not the page (#1943)");
    await opener.press("Enter");
    await pageB.getByRole("button", { name: /^1 hour/ }).press("Enter");
    const snoozedAt = Date.now();
    // It leaves Needs you on both, for the collapsed Snoozed group, and its notification closes.
    await probe(pageB).waitFor({ state: "detached", timeout: 10_000 });
    const focused = async () =>
      pageB.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        const list = document.querySelector('section[aria-label="Inbox"]');
        return {
          onHead: !!a && !!list?.contains(a) && a.dataset.head === "snoozed",
          what: a ? a.outerHTML.slice(0, 80) : "nothing",
        };
      });
    let landed = await focused();
    for (let i = 0; i < 20 && !landed.onHead; i++) {
      await pageB.waitForTimeout(100);
      landed = await focused();
    }
    console.log(`  focus after the snooze: ${landed.what}`);
    if (!landed.onHead)
      throw new Error(`focus is not on the Snoozed head after a snooze: ${landed.what}`);
    await pageB.getByRole("button", { name: /^Snoozed\s*1/ }).waitFor();
    for (let i = 0; i < 50 && (await probes(pageB)).length > 0; i++)
      await pageB.waitForTimeout(200);
    if ((await probes(pageB)).length > 0) throw new Error("the snooze left its notification up");
    await page.goto(ORIGIN);
    await page.getByRole("button", { name: /^Snoozed\s*1/ }).waitFor({ timeout: 30_000 });
    if (await probe(page).count()) throw new Error("the snoozed question is still listed open");
    await shoot(page, "inbox-snoozed");
    step("closing Snoozed or History leaves its head (#1824)");
    const snoozedHead = page.getByRole("button", { name: /^Snoozed\s*1/ });
    await foldKeepsHead(page, snoozedHead);
    await foldKeepsHead(page, page.getByRole("button", { name: /History/ }));
    // The agent hears of it when it would block.
    const snoozeWait = cli(
      "snooze-wait",
      ["wait", snoozeId as string, "--timeout", "60s"],
      machineHome,
    );
    await snoozeWait.waitFor(
      // "until 19:16", or "until tomorrow 00:02" when it ends after midnight.
      /Snoozed d_\S+ \(Snooze probe: ship the docs\?\) until (?:tomorrow )?\d\d:\d\d: no answer before then\./,
    );
    if ((await snoozeWait.exited) !== 3)
      throw new Error("wait on a snoozed question did not exit 3");
    // At its time the server pushes every device once: one notification, back from snooze.
    const back = async (p: Page) =>
      (await probes(p)).filter((n) => n.body.startsWith("Back from snooze")).length;
    while ((await back(pageB)) < 1) {
      if (Date.now() - snoozedAt > 5 * 60_000)
        throw new Error("the snoozed question never came back");
      await pageB.waitForTimeout(2_000);
    }
    await pageB.clock.setSystemTime(new Date());
    await pageB.waitForTimeout(20_000);
    if ((await probes(pageB)).length !== 1) throw new Error("the return notified more than once");
    await page.reload();
    await probe(page).waitFor({ timeout: 30_000 });
    await probe(page).click();
    await selected(page).getByRole("button", { name: /^Ship/ }).click();
    await orderAcrossClients(page, pageB, machineHome);
  }
  if (SHARD === "snooze") return;
  // Its notifications are on once the snooze ran.
  if (!runs("snooze")) await notifyB();

  step(
    "while the first browser is in use, the second hears nothing, then a hold after it leaves (#848, #1003)",
  );
  // The second browser must not count as in use itself: no input on it for longer than the server
  // trusts its last beat.
  await pageB.reload();
  const quietSince = Date.now();
  await page.goto(`${ORIGIN}/settings`);
  const holdTime = page.getByRole("radiogroup", { name: /^Quiet other devices while you/ });
  await holdTime.waitFor({ timeout: 30_000 });
  await choose(holdTime, "15 s");
  await shoot(page, "settings-hold");
  await page.goto(ORIGIN);
  const use = async () => {
    await page.mouse.move(20 + Math.random() * 200, 200);
    await page.mouse.move(240, 220);
  };
  while (Date.now() - quietSince < 80_000) {
    await use();
    await page.waitForTimeout(5_000);
  }
  const holdAsk = cli(
    "hold-ask",
    [
      ...["ask", "--question", "Hold probe: tag the release?", "--option", "Tag"],
      ...["--option", "Wait", "--project", "starbridge", "--session", "e2e"],
    ],
    machineHome,
  );
  const [holdId] = await holdAsk.waitFor(/d_[\w-]+/);
  if ((await holdAsk.exited) !== 0) throw new Error("ask for the hold probe failed");
  const askedAt = Date.now();
  const held = async () =>
    ((await pageB.evaluate(NOTIFICATIONS)) as { title: string }[]).filter((n) =>
      n.title.startsWith("Hold probe"),
    ).length;
  // The browser in use lists it at once; the other hears nothing while it stays in use, well
  // past the hold time.
  await page.locator(`button[data-id="${holdId}"]`).waitFor({ timeout: 15_000 });
  while (Date.now() - askedAt < 25_000) {
    await use();
    if ((await held()) > 0)
      throw new Error("the second browser was notified while the first was in use");
    await page.waitForTimeout(1_000);
  }
  // The first browser's page goes hidden: presence ends, and the hold counts from now.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const leftAt = Date.now();
  while ((await held()) === 0) {
    if (Date.now() - leftAt > 40_000) throw new Error("the held notification never came");
    await page.waitForTimeout(1_000);
  }
  if (Date.now() - leftAt < 12_000)
    throw new Error(`notified ${Date.now() - leftAt} ms after leaving, under the 15 s hold`);
  await page.evaluate(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator(`button[data-id="${holdId}"]`).click();
  await selected(page).getByRole("button", { name: /^Tag/ }).click();
  await page.goto(`${ORIGIN}/settings`);
  await choose(holdTime, "Off");

  step("replace the recovery key with the current one; the second browser says so once (#348)");
  await page.goto(`${ORIGIN}/settings`);
  const recoveryRow = page.getByRole("region", { name: "Devices" });
  await recoveryRow.getByText(/^Set .* on this browser$/).waitFor();
  await follow(page, recoveryRow.getByRole("link", { name: "Replace" }), "/settings/recovery-key");
  await page.getByRole("heading", { name: "Replace the recovery key" }).waitFor();
  await page
    .getByText("Lost it? Without the current key it can't be replaced.", { exact: false })
    .waitFor();
  await page.getByLabel("Your current recovery key").fill(key);
  await page.getByText("28 of 28 characters").waitFor();
  await shoot(page, "recovery-key-replace");
  await page.getByRole("button", { name: "Make a new key" }).click();
  await page.getByRole("heading", { name: "Save your new recovery key" }).waitFor();
  const newKey = ((await page.getByTestId("new-recovery-key").textContent()) ?? "").trim();
  if (newKey === key || !/^([0-9A-Z]{4}){7}$/.test(newKey))
    throw new Error(`expected a new recovery key, got: ${newKey}`);
  await shoot(page, "recovery-key-new");
  await page.getByLabel(/I wrote this key down/).check();
  await page.getByRole("button", { name: "Save the new key" }).click();
  await page.getByRole("heading", { name: "Recovery key replaced" }).waitFor();
  await pageB.goto(ORIGIN);
  await pageB.getByText(/^Recovery key replaced on .+, .+\.$/).waitFor({ timeout: 30_000 });
  await shoot(pageB, "inbox-recovery-notice");
  await pageB.getByRole("button", { name: "OK" }).click();
  await pageB.getByText(/^Recovery key replaced on /).waitFor({ state: "detached" });

  await page.goto(`${ORIGIN}/settings`);
  await recoveryRow.getByText(/^Replaced .* on this browser$/).waitFor();
  await shoot(page, "devices-recovery");

  step(
    "the page that passes an app's sign-in on offers to turn off this browser's notifications, and Devices shows it (#943)",
  );
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  failPage = pageB;
  await pageB.goto(`${ORIGIN}/app/auth?code=stub-code&state=${challenge}`);
  await pageB.getByRole("link", { name: "Open Starbridge" }).waitFor();
  // The app trades the code, as the desktop app does once the browser hands it on.
  const traded = await fetch(`${ORIGIN}/v1/auth/app/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "stub-code", verifier }),
  });
  if (traded.status !== 200) throw new Error(`the app's sign-in failed: ${traded.status}`);
  await pageB.getByRole("button", { name: "Turn off in this browser" }).click({ timeout: 15_000 });
  await pageB.getByText(/^This browser no longer notifies you/).waitFor();
  await shoot(pageB, "app-signin-handoff");
  failPage = page;
  const devicesOf = (p: Page) => p.getByRole("region", { name: "Devices" });
  await page.goto(`${ORIGIN}/settings`);
  await devicesOf(page)
    .getByText(/^Device · added .* · Notifications off$/)
    .waitFor();
  // Off stays off: no banner offers them again, and the switch turns them back on.
  await pageB.goto(ORIGIN);
  await pageB.waitForTimeout(2_000);
  if (await pageB.getByRole("button", { name: "Turn on notifications" }).count())
    throw new Error("the banner offers notifications the owner turned off");
  await pageB.goto(`${ORIGIN}/settings`);
  const thisDevice = pageB.getByRole("switch", { name: "Notifications on this device" });
  if (await thisDevice.isChecked()) throw new Error("the switch still says on");
  // The switch turns on once the browser granted and the subscription went through.
  await thisDevice.click();
  await pageB
    .getByRole("switch", { name: "Notifications on this device", checked: true })
    .waitFor();
  await page.reload();
  await devicesOf(page)
    .getByText(/^Device · added .* · Notifications on$/)
    .waitFor();

  step("revoke the second browser");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  const devices = page.getByRole("region", { name: "Devices" });
  await devices.getByText("Device · this browser").waitFor();
  // A notification left from before: the server's refusal closes it. Shown before the revoke,
  // since the directory append wakes the second browser's poll, which can be refused at once.
  await pageB.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready.then((r) =>
        r.showNotification("Left over", { tag: "e2e-left", requireInteraction: true }),
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the left-over notification hung")), 10_000),
      ),
    ]),
  );
  if (!(await pageB.evaluate(NOTIFICATIONS)).some((n) => n.tag === "e2e-left"))
    throw new Error("the left-over notification did not show");
  // Devices list this browser, then the others by when they joined: the second browser first.
  await devices.getByRole("button", { name: "Revoke" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  // Without a reload: the page's next poll gets the 401 and drops what it showed (#343). The
  // server's 401 alone is unsigned: the browser keeps its keys and shows the refusal (#310).
  await pageB.getByText("The server says this browser was revoked.").waitFor({ timeout: 25_000 });
  if ((await pageB.getByRole("heading", { name: "Inbox" }).count()) > 0)
    throw new Error("the revoked browser still shows its inbox");
  await pageB
    .waitForFunction(
      () => navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((n) => !n.length),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => {
      throw new Error("the refusal left notifications on screen");
    });
  // Another one, so the device list's verdict, not the refusal, has to close it.
  await pageB.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready.then((r) =>
        r.showNotification("Left over", { tag: "e2e-left", requireInteraction: true }),
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the left-over notification hung")), 10_000),
      ),
    ]),
  );
  // In the background since the race above, Firefox paints this window no more frames, and a
  // click waits for one.
  await pageB.bringToFront();
  await pageB.getByRole("link", { name: SIGN_IN }).click();
  // Signed in, the device list confirms the revocation.
  await pageB
    .getByRole("heading", { name: /^This browser was removed from your account by / })
    .waitFor({ timeout: 30_000 });
  if ((await pageB.evaluate(NOTIFICATIONS)).length > 0)
    throw new Error("a revoked browser still shows notifications");
  const keptRevoked = await keptRecords(pageB);
  if (keptRevoked.length > 0)
    throw new Error(`a revoked browser kept its inbox: ${keptRevoked.slice(0, 5).join(", ")}`);
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
  await confirmCheck(page, linked, "pair-link", join(tmp, "laptop"));
  await linked.waitFor(/✓ Paired as laptop/);
  if ((await linked.exited) !== 0) throw new Error("pair by link failed");

  if (!runs("inbox")) {
    await page.goto(ORIGIN);
    await leaveOpen();
  }
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

  step(
    "recover a third browser with the new key: the old one is refused, every other member goes (#348, #363)",
  );
  const c = await context({ permissions: ["notifications"] });
  await watchCsp(c);
  const pageC = await signIn(c);
  await pageC.getByRole("button", { name: "Use the recovery key" }).click();
  const entry = pageC.getByLabel("Your recovery key");
  await noWordsAsked(pageC);
  await entry.fill(`${key.slice(0, 9)}U`);
  await pageC.getByText('Character 10, "U", is not in a recovery key.').waitFor();
  await shoot(pageC, "recovery-typo");
  // The key replaced above: a recovery key, but no longer this account's.
  await entry.fill(key);
  await pageC.getByRole("button", { name: "Recover" }).click();
  await pageC.getByText("This is a recovery key, but not this account's current one.").waitFor();
  // Lower case, in groups split by spaces: the key reads all the same.
  await entry.fill(newKey.toLowerCase().match(/.{4}/g)?.join(" ") ?? "");
  await pageC.getByText("28 of 28 characters").waitFor();
  await pageC.getByRole("button", { name: "Recover" }).click();
  await pageC.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  // Recovery keeps no earlier device. The server's 401 is unsigned, so the first browser keeps
  // its keys and shows the refusal; signed in, the device list confirms it (#310).
  await page.goto(ORIGIN);
  await page.getByText("The server says this browser was revoked.").waitFor({ timeout: 30_000 });
  await page.getByRole("link", { name: SIGN_IN }).click();
  await page
    .getByRole("heading", {
      name: "This browser was removed from your account by your recovery key",
    })
    .waitFor({ timeout: 30_000 });

  step("sign out the recovered browser: it leaves the devices and forgets its keys");
  await pageC
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await pageC.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready.then((r) =>
        r.showNotification("Left over", { tag: "e2e-left", requireInteraction: true }),
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the left-over notification hung")), 10_000),
      ),
    ]),
  );
  if (!(await pageC.evaluate(NOTIFICATIONS)).some((n) => n.tag === "e2e-left"))
    throw new Error("the left-over notification did not show");
  // What the browser keeps of the account in localStorage goes too; the display prefs stay (#2014).
  await pageC.evaluate(() => {
    for (const k of ["quota-settings", "quota-account", "quota-notified", "run-notified"])
      localStorage.setItem(`starbridge:${k}`, '{"v":1,"account":"a_left"}');
    localStorage.setItem("starbridge:prefs", '{"v":1,"theme":"dark"}');
  });
  await pageC.getByRole("button", { name: "Sign out" }).click();
  await pageC.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
  // With no keys left, the browser is a visitor: the landing page, not "Sign in to Starbridge".
  await pageC
    .getByRole("heading", { name: /Know the moment your agent is stuck/ })
    .waitFor({ timeout: 30_000 });
  // Notifications hold decrypted questions: none outlive the sign-out (#311).
  if ((await pageC.evaluate(NOTIFICATIONS)).length > 0)
    throw new Error("signing out left notifications on screen");
  const left = await pageC.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith("starbridge:"))
      .sort(),
  );
  if (left.join() !== "starbridge:prefs")
    throw new Error(`signing out left these localStorage keys: ${left.join(", ")}`);
  const keptLeft = await keptRecords(pageC);
  if (keptLeft.length > 0)
    throw new Error(`signing out left the kept inbox: ${keptLeft.slice(0, 5).join(", ")}`);

  step("delete the account: typed confirmation, then a new sign-in starts a new account (#1104)");
  const d = await context({ permissions: ["notifications"] });
  await watchCsp(d);
  const pageD = await signIn(d);
  // Unpaired, the join screen deletes too, and says why that is the way out (#1117).
  await pageD.getByRole("button", { name: "Delete account" }).click();
  await pageD
    .getByRole("dialog")
    .getByText(/end-to-end encrypted/)
    .waitFor();
  await pageD.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await pageD.getByRole("dialog").waitFor({ state: "hidden" });
  await pageD.getByRole("button", { name: "Use the recovery key" }).click();
  await pageD.getByLabel("Your recovery key").fill(newKey);
  await pageD.getByRole("button", { name: "Recover" }).click();
  await pageD.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  await pageD
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await pageD.getByRole("button", { name: "Delete account" }).click();
  const dialog = pageD.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Delete account" });
  if (await confirm.isEnabled()) throw new Error("Delete account worked before typing delete");
  await dialog.getByLabel("Type delete to confirm").fill("delete");
  // Deleting the account forgets the localStorage keys too, as signing out does (#2014).
  await pageD.evaluate(() => {
    localStorage.setItem("starbridge:quota-settings", '{"v":1}');
    localStorage.setItem("starbridge:quota-account", '{"v":1,"account":"a_gone"}');
  });
  await confirm.click();
  await pageD
    .getByRole("heading", { name: /Know the moment your agent is stuck/ })
    .waitFor({ timeout: 30_000 });
  const keptAfterDelete = await pageD.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("starbridge:quota")),
  );
  if (keptAfterDelete.length > 0)
    throw new Error(`deleting the account left ${keptAfterDelete.join(", ")}`);
  await d.clearCookies();
  await pageD.goto(ORIGIN);
  await pageD.getByRole("link", { name: SIGN_IN }).click();
  // The same GitHub user gets an account with no devices, not the deleted one's recovery screen.
  await pageD.getByRole("heading", { name: "Set up your account" }).waitFor({ timeout: 30_000 });
}

try {
  await main();
  await keepEvidence();
  await ff?.close();
  if (violations.length) throw new Error(`CSP violations:\n${violations.join("\n")}`);
  console.log("\nE2E PASSED");
} catch (e) {
  console.error("\nE2E FAILED:", e);
  await keepEvidence(e).catch(() => {});
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
  await ff?.close().catch(() => {});
  shutdown();
  // A browser that would not close keeps Node running: a CI job would hang until its timeout.
  process.exit();
}
