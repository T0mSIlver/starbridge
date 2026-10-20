// A question with a long unbroken path on an iPhone-wide screen (#1254): WebKit at 390 px, the
// card in the list and the detail, each checked by layout.ts for text past its box or the window.
//
//   node web/e2e/narrow.ts   (Node 22.6+ runs it as is)
//
// Needs `npx playwright install webkit` once (and `install-deps webkit` on Linux). Builds the web
// app, then serves it and the server on free ports of localhost. CI runs it in the devices part.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page, webkit } from "playwright";
import { layoutProblems } from "./layout.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const WEB = join(ROOT, "web");
/**
 * Ports nothing else listens on, so runs beside others on one machine never collide (as in
 * run.ts). Each stays held until `free` hands it to its process.
 */
const held = new Map<number, ReturnType<typeof createServer>>();
const hold = (): Promise<number> =>
  new Promise((done) => {
    const port = 20000 + Math.floor(Math.random() * 12000);
    const s = createServer()
      .once("error", () => done(hold()))
      .listen(port, () => {
        held.set(port, s);
        done(port);
      });
  });
const free = (port: number) => new Promise((done) => held.get(port)?.close(done));
const PORTS = { web: await hold(), server: await hold() };
const ORIGIN = `http://localhost:${PORTS.web}`;
const SERVER = `http://localhost:${PORTS.server}`;
const TOKEN = "narrow-check-owner-token";
const QUESTION =
  "Commit the docs (handoff-protocol.md, ACTIVATION.md, no push)? And the 136 MB test folder " +
  "left by the first run (drafts/handoffs/20261011T190312Z-codex-opencode-skills-test.runtime/), " +
  "do I delete it?";
const tmp = mkdtempSync(join(tmpdir(), "starbridge-narrow-"));
const children: ChildProcess[] = [];
/** Each process's output, printed when the check fails. */
const logs = new Map<string, () => string>();
let current: Page | undefined;

/** Starts a process; `waitFor` resolves on the first match in its output so far. */
function start(name: string, cmd: string, args: string[], env: object) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(p);
  let out = "";
  const feed = (b: Buffer) => {
    out += b;
  };
  p.stdout.on("data", feed);
  p.stderr.on("data", feed);
  logs.set(name, () => out);
  const exited = new Promise<number>((r) => p.on("exit", (code) => r(code ?? -1)));
  return {
    exited,
    async waitFor(re: RegExp, ms = 30_000): Promise<RegExpMatchArray> {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const m = out.match(re);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`${name}: no ${re} within ${ms} ms:\n${out}`);
    },
  };
}

const cli = (name: string, args: string[]) =>
  start(name, "bun", ["run", join(ROOT, "cli/src/main.ts"), ...args], {
    STARBRIDGE_CONFIG_DIR: join(tmp, "machine"),
    STARBRIDGE_SERVER: SERVER,
  });

async function expectFits(page: Page, where: string) {
  const width = page.viewportSize()?.width;
  // Measured at rest: the detail slides in.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const problems = (await layoutProblems(page, { phone: width === 390 })).filter((p) =>
    ["page-width", "spills", "offscreen", "clipped"].includes(p.kind),
  );
  if (problems.length)
    throw new Error(`${where}:\n${problems.map((p) => `  ${p.kind}: ${p.what}`).join("\n")}`);
  console.log(`ok: ${where} fits ${width} px`);
}

async function main() {
  await free(PORTS.server);
  await start("server", "bun", ["run", "server/src/main.ts"], {
    PORT: PORTS.server,
    DB_PATH: join(tmp, "starbridge.db"),
    PUBLIC_URL: ORIGIN,
    OWNER_TOKEN: TOKEN,
  }).waitFor(/starbridge server on port/);
  const env = { STARBRIDGE_SERVER: SERVER };
  if (spawnSync("bun", ["run", "build"], { cwd: WEB, env: { ...process.env, ...env } }).status)
    throw new Error("web build failed");
  const standalone = join(WEB, ".next/standalone/web");
  cpSync(join(WEB, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  cpSync(join(WEB, "public"), join(standalone, "public"), { recursive: true });
  await free(PORTS.web);
  await start("web", "node", [join(standalone, "server.js")], {
    ...env,
    PORT: String(PORTS.web),
    HOSTNAME: "127.0.0.1",
  }).waitFor(/Ready|started server/i);

  const browser = await webkit.launch();
  try {
    const page = await browser
      .newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
      .then((c) => c.newPage());
    current = page;
    page.setDefaultTimeout(30_000);

    // The first device of a new account, signed in with the owner token.
    await page.goto(ORIGIN);
    await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
    await page.getByLabel("Owner token").fill(TOKEN);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel(/I stored this key/).check({ force: true });
    await page.getByRole("button", { name: "Create the account" }).click();
    await page.getByRole("heading", { name: "Inbox" }).waitFor();

    // A machine, paired from Add a device, asks the question.
    const pair = cli("pair", ["pair", "--name", "hpc-login1"]);
    const code = (await pair.waitFor(/Pairing code: (\S+)/))[1] as string;
    await page.goto(`${ORIGIN}/settings/devices/add`);
    await page.getByLabel("Pair a machine or device").fill(code);
    await page.getByRole("button", { name: "Check code" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await pair.waitFor(/Check code: (\S+)/);
    if ((await cli("confirm", ["pair", "--confirm"]).exited) !== 0)
      throw new Error("pair --confirm failed");
    if ((await pair.exited) !== 0) throw new Error("pair failed");
    const ask = cli("ask", [
      "ask",
      ...["--question", QUESTION, "--context", "Both files are written."],
      ...["--option", "Commit and delete", "--option", "Commit only"],
      ...["--project", "research-control-plane", "--session", "narrow"],
    ]);
    const [askedId] = await ask.waitFor(/d_[\w-]+/);

    await page.goto(ORIGIN);
    const card = page.getByText(/^Commit the docs/).first();
    await card.waitFor();
    await expectFits(page, "the card in the list");
    await card.click();
    await page.getByRole("heading", { name: /Commit the docs/ }).waitFor();
    await expectFits(page, "the detail");

    const empty = page.getByText("Nothing needs you");
    const open = () => page.evaluate(() => new URLSearchParams(location.search).get("item"));

    // A Find query that matches no open card settles nothing: the open card stays (#1605). The
    // Find box shows from 600 px.
    await page.setViewportSize({ width: 800, height: 844 });
    const finder = page.getByRole("textbox", { name: "Find" });
    await finder.fill("zzz no such card");
    await page.waitForTimeout(1000);
    if (!(await open())) throw new Error("a Find query with no match closed the open card");
    if (await page.getByText("Answered", { exact: true }).count())
      throw new Error("a Find query with no match shows the open card as Answered");
    await page.getByRole("heading", { name: /Commit the docs/ }).waitFor();
    await finder.fill("");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: /Commit the docs/ }).waitFor();
    console.log("ok: a Find query with no match keeps the open card");

    // The last card, settled from the machine while it is open, returns to the empty list (#1583).
    const settle = cli("settle", [
      "settle",
      askedId as string,
      "--outcome",
      "withdrawn",
      "--reason",
      "Done by hand",
    ]);
    if ((await settle.exited) !== 0) throw new Error("settle failed");
    await empty.waitFor();
    if (await open()) throw new Error("the settled last card is still open");
    console.log("ok: settling the last card returns to the empty list");

    // The same for the last card answered with a tap.
    const again = cli("ask-again", [
      "ask",
      ...["--question", "Push the branch?", "--option", "Push", "--option", "Hold"],
      ...["--project", "research-control-plane", "--session", "narrow-again"],
    ]);
    await again.waitFor(/d_[\w-]+/);
    await page.getByText("Push the branch?", { exact: true }).first().click();
    await page.getByText("Hold", { exact: true }).click();
    await empty.waitFor();
    if (await open()) throw new Error("the answered last card is still open");
    console.log("ok: answering the last card returns to the empty list");

    // A run with no break point (a commit hash, a token) wraps in the row, the card and the
    // detail's context, at a phone's width and a desktop's (#1906).
    const hash = "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";
    const unbroken = cli("ask-unbroken", [
      "ask",
      ...["--question", `Revert commit ${hash}?`, "--context", "x".repeat(600)],
      ...["--option", "Revert", "--option", "Keep"],
      ...["--project", "research-control-plane", "--session", "narrow-unbroken"],
    ]);
    await unbroken.waitFor(/d_[\w-]+/);
    const row = page.getByText(/^Revert commit/).first();
    await row.waitFor();
    await expectFits(page, "a card with a commit hash");
    await row.click();
    await page.getByRole("heading", { name: /Revert commit/ }).waitFor();
    await expectFits(page, "the detail with an unbroken context");
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.getByRole("heading", { name: /Revert commit/ }).waitFor();
    await expectFits(page, "the row and detail with a commit hash");
    // At this width the list and the detail are panes that clip or scroll, which layout.ts lets
    // text run past: no box may hold content wider than itself.
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 1)
        .filter((el) => getComputedStyle(el).overflowX !== "visible")
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}.${el.className} ${el.scrollWidth} in ${el.clientWidth}`,
        ),
    );
    if (wide.length) throw new Error(`text runs past its pane at 1280 px:\n  ${wide.join("\n  ")}`);
    console.log("ok: nothing runs past its pane at 1280 px");
  } catch (e) {
    await current?.screenshot({ path: join(tmpdir(), "starbridge-narrow-failure.png") });
    throw e;
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  for (const [name, out] of logs) console.error(`--- ${name}\n${out().slice(-4000)}`);
  process.exitCode = 1;
} finally {
  for (const p of children) p.kill();
  rmSync(tmp, { recursive: true, force: true });
}
