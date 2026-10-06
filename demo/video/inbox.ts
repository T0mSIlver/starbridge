/**
 * The inbox take: two agents on two machines (Claude Code on "workstation", Codex on "build
 * server") ask at once; a browser on the web inbox shows both and answers each; the first one's
 * run reports its progress there. Writes <out>/browser.webm and <out>/events.json, which
 * compose.ts turns into the video.
 *
 *   bun demo/video/inbox.ts <stack dir> --sign-in   once: the browser joins the stack's account
 *   bun demo/video/inbox.ts <stack dir> <out dir>
 *
 * Env: WEB, the web app built against the stack's server (default http://127.0.0.1:8641).
 */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { Agent, EVAL, PRICING } from "./agents";
import { HOLE } from "./compose";
import { OWNER_TOKEN } from "./stack";

const WEB = process.env.WEB ?? "http://127.0.0.1:8641";

/** A pointer drawn in the page, since a recording shows none. */
const POINTER = `addEventListener("DOMContentLoaded", () => {
  const p = document.createElement("div");
  p.style.cssText = "position:fixed;z-index:99999;width:22px;height:22px;margin:-11px 0 0 -11px;" +
    "border-radius:50%;background:#f1f1f1cc;box-shadow:0 0 0 2px #0c0c0c80;pointer-events:none;" +
    "left:-50px;top:-50px;transition:transform .12s";
  document.body.append(p);
  addEventListener("mousemove", (e) => { p.style.left = e.clientX + "px"; p.style.top = e.clientY + "px"; });
  addEventListener("mousedown", () => { p.style.transform = "scale(.7)"; });
  addEventListener("mouseup", () => { p.style.transform = ""; });
});`;

/** Moves the pointer to the button, visibly, and clicks it, aiming again if the page moved it. */
async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true }).first();
  for (let i = 0; i < 3; i++) {
    const box = await button.boundingBox();
    if (!box) throw new Error(`no "${name}" button in the inbox`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: i ? 8 : 25 });
    await Bun.sleep(300);
    const now = await button.boundingBox();
    if (now && Math.abs(now.y - box.y) < 2 && Math.abs(now.x - box.x) < 2) break;
  }
  await page.mouse.down();
  await Bun.sleep(120);
  await page.mouse.up();
}

/** The browser is this much smaller than the hole; compose.ts scales its recording up to fit. */
const SCALE = 1.4;
const SIZE = { width: Math.round(HOLE.inbox.w / SCALE), height: Math.round(HOLE.inbox.h / SCALE) };

/**
 * What the page's service worker relays when a Web Push arrives. A local stack has no Web Push,
 * so the take delivers it after each ask, as the hosted relay would; else the inbox shows new
 * questions only at its next poll, up to 20 s later.
 */
const pushed = (page: Page) =>
  page.evaluate(() =>
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent("message", { data: { type: "starbridge:push", kind: "decision" } }),
    ),
  );

const context = (dir: string, video?: string) =>
  chromium.launchPersistentContext(join(dir, "browser"), {
    // The new headless mode: the old one denies notifications, and the inbox then says so.
    channel: "chromium",
    viewport: SIZE,
    colorScheme: "dark",
    permissions: ["notifications"],
    ...(video ? { recordVideo: { dir: video, size: SIZE } } : {}),
  });

/** Joins the stack's account: owner token, then digits, which the stack approves. */
async function signIn(dir: string) {
  const ctx = await context(dir);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(WEB);
  await page.getByRole("button", { name: "Use your own server" }).click();
  await page.locator("#owner-token").fill(OWNER_TOKEN);
  await page.locator("#owner-token").press("Enter");
  await page.getByRole("button", { name: "Can't scan? Compare digits" }).click();
  await page.getByRole("button", { name: "They match" }).click();
  await page.getByText("Inbox").first().waitFor({ timeout: 60_000 });
  await ctx.close();
  console.log("the browser joined the account");
}

async function take(dir: string, out: string) {
  mkdirSync(out, { recursive: true });
  const raw = join(out, "video");
  const ctx = await context(dir, raw);
  await ctx.addInitScript(POINTER);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // The recording begins with the page.
  const started = performance.now();
  await page.goto(WEB);
  await page.getByText("Nothing needs you").waitFor({ timeout: 30_000 });
  const t0 = performance.now();
  const clock = () => (performance.now() - t0) / 1000;
  const first = new Agent(EVAL, dir, clock);
  const second = new Agent(PRICING, dir, clock);
  const events: Record<string, number> = {};
  const mark = (name: string) => {
    events[name] = clock();
    console.log(`${clock().toFixed(2)} ${name}`);
  };

  const stop = async () => {
    await Promise.all([first.stop(), second.stop()]);
    await ctx.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)));
  try {
    await Bun.sleep(2500);
    await first.ask(join(out, "question.png"));
    await pushed(page);
    await Bun.sleep(1200);
    await second.ask();
    await pushed(page);
    for (const a of [first, second]) await page.getByText(a.script.question.question).waitFor();
    mark("both");
    await Bun.sleep(3000);
    await press(page, EVAL.answer);
    mark("first");
    await first.wait(15);
    // After the agent's own line, as in the terminal; a failed take's stop() makes it reject.
    await Bun.sleep(1200);
    const running = first.run();
    running.catch(() => {});
    await Bun.sleep(2000);
    await press(page, PRICING.answer);
    mark("second");
    await second.wait(15);
    await running;
    await Bun.sleep(3500);
    mark("end");
  } finally {
    await stop();
  }
  const [file] = readdirSync(raw);
  if (!file) throw new Error("the browser left no recording");
  renameSync(join(raw, file), join(out, "browser.webm"));
  const settled = (second.answered ?? 0) + 1.5;
  const take = {
    layout: "inbox",
    end: events.end,
    // The recording began when the browser opened, before the take's clock.
    offset: (t0 - started) / 1000,
    poster: (events.both ?? 0) + 1.5,
    captions: [
      [0, events.both, "Two agents on two machines, each with a question."],
      [events.both, events.first, "Every question lands in one inbox, on the web too."],
      [events.first, settled, "Each answer goes back to the session that asked."],
      [settled, events.end, "Runs report their progress there too (sped up 6×)."],
    ],
    // The run takes a minute; once both are answered, its middle plays at 6×.
    fast: [{ from: settled, to: (first.ran ?? 0) - 0.5, rate: 6 }],
    panes: [first, second],
  };
  writeFileSync(join(out, "events.json"), `${JSON.stringify(take, null, 2)}\n`);
  console.log(`take in ${out}`);
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "demo-video");
  if (process.argv[3] === "--sign-in") await signIn(dir);
  else await take(dir, resolve(process.argv[3] ?? join(dir, "inbox-take")));
}
