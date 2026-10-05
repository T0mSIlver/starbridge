/**
 * Shows cards the agents posted in the real web inbox and saves a screenshot of each.
 *
 *   bun evals/skill/render.ts --out <dir> <record.json>[:<decision index>]...
 *
 * Starts the stand-in GitHub, the server and the built web page as web/e2e/run.ts does, signs in
 * with headless Chromium, pairs a CLI, re-posts each card with `starbridge ask --json` and
 * screenshots the selected decision at desktop width. Writes `<record name>-d<index>.png`.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "../../web/node_modules/playwright/index.mjs";

const { values: opt, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { out: { type: "string" }, "no-build": { type: "boolean" } },
});
const out = resolve(opt.out ?? "evals/skill/cards");
mkdirSync(out, { recursive: true });
const ROOT = resolve(import.meta.dir, "../..");
const WEB = join(ROOT, "web");
const PORTS = { web: 3880, server: 3881, github: 3882, push: 3883 };
const ORIGIN = `http://localhost:${PORTS.web}`;
const tmp = mkdtempSync(join(tmpdir(), "cards-"));
const children: ChildProcess[] = [];

function start(name: string, cmd: string, args: string[], env: object = {}, cwd = ROOT) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(p);
  let text = "";
  p.stdout?.on("data", (c) => (text += c));
  p.stderr?.on("data", (c) => (text += c));
  return {
    exited: new Promise<number>((r) => p.on("exit", (code) => r(code ?? -1))),
    async waitFor(re: RegExp, ms = 60_000) {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
        const m = text.match(re);
        if (m) return m;
      }
      throw new Error(`${name}: no ${re} within ${ms} ms\n${text.slice(-2000)}`);
    },
  };
}

const machineHome = join(tmp, "machine");
const cli = (args: string[]) =>
  start("cli", process.execPath, ["run", join(ROOT, "cli/src/main.ts"), ...args], {
    STARBRIDGE_CONFIG_DIR: machineHome,
    STARBRIDGE_SERVER: `http://localhost:${PORTS.server}`,
  });

try {
  const services = start("services", process.execPath, [join(WEB, "e2e/services.ts")], {
    GITHUB_PORT: PORTS.github,
    PUSH_PORT: PORTS.push,
  });
  await services.waitFor(/"event":"ready"/);
  const server = start("server", process.execPath, ["run", "server/src/main.ts"], {
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
  const env = { STARBRIDGE_SERVER: `http://localhost:${PORTS.server}` };
  if (!opt["no-build"] || !existsSync(join(WEB, ".next/standalone/web/server.js"))) {
    const b = spawnSync(process.execPath, ["run", "build"], {
      cwd: WEB,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    if (b.status) throw new Error("web build failed");
  }
  const standalone = join(WEB, ".next/standalone/web");
  cpSync(join(WEB, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  cpSync(join(WEB, "public"), join(standalone, "public"), { recursive: true });
  const web = start("web", "node", [join(standalone, "server.js")], {
    ...env,
    PORT: String(PORTS.web),
    HOSTNAME: "127.0.0.1",
  });
  await web.waitFor(/Ready|started server/i);

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(ORIGIN);
  await page.getByRole("link", { name: "Sign in with GitHub" }).first().click();
  await page.getByRole("button", { name: "Make keys" }).click();
  await page.getByLabel(/I wrote these words down/).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Inbox" }).waitFor();

  const pair = cli(["pair", "--name", "devbox"]);
  const code = (await pair.waitFor(/Pairing code: (\S+)/))[1] as string;
  await page.getByRole("link", { name: "Devices" }).click();
  await page.getByLabel("Pair a machine or device").fill(code);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  if ((await pair.exited) !== 0) throw new Error("pair failed");
  await page.getByRole("link", { name: "Inbox" }).click();

  for (const spec of positionals) {
    const [file, index = "0"] = spec.split(":") as [string, string?];
    const rec = JSON.parse(readFileSync(file, "utf8"));
    const d = rec.decisions[Number(index)];
    const name = `${basename(file, ".json")}-d${index}`;
    // The images run.ts saved beside the records.
    const images = (d.images ?? []).map((_: unknown, j: number) =>
      join(dirname(file), `${rec.agent}-${basename(file, ".json")}-d${index}-img${j}.png`),
    );
    const card = {
      question: d.question,
      context: d.context,
      options: d.options,
      recommended: d.options.length ? d.recommended : undefined,
      default: d.default.action,
      // Two hours from now, when the original had a default time.
      ...(d.default.at ? { defaultAt: "2h" } : {}),
      links: (d.links ?? []).map((l: { url: string }) => l.url),
      ...(images.length ? { images } : {}),
      ...(d.answerIn ? { answerIn: d.answerIn.url } : {}),
    };
    const json = join(tmp, `${name}.json`);
    writeFileSync(json, JSON.stringify(card));
    const ask = cli(["ask", "--json", json, "--project", "notes", "--session", "eval", "--session-title", rec.scenario]);
    if ((await ask.exited) !== 0) throw new Error(`ask failed for ${spec}`);
    await page.getByText(d.question).first().click({ timeout: 30_000 });
    const pane = page.locator('section[aria-label="Selected decision"]');
    await pane.getByText(d.question).waitFor();
    await page.waitForTimeout(300);
    await pane.screenshot({ path: join(out, `${name}.png`) });
    console.log(join(out, `${name}.png`));
  }
  await browser.close();
} finally {
  for (const p of children) p.kill();
  rmSync(tmp, { recursive: true, force: true });
}
