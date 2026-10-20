// Drives one scenario on the whole product, for an agent verifying a pull request
// (.agents/skills/verify-web): the stack of run.ts, a GitHub sign-in, the first device set up and
// one machine paired, then the scenario's own steps.
//
//   xvfb-run -a node web/e2e/drive.ts <scenario.ts> <out dir>
//
// A scenario's default export takes a Scenario and drives it. `shot` writes a screenshot at 360,
// 768 and 1280 px in light and dark to the out dir, and returns their paths for the agent to look
// at. Exits 1 when the scenario throws, after a screenshot of where it stopped.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
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
  tmp,
} from "./stack.ts";

export type Scenario = {
  page: Page;
  context: BrowserContext;
  /** The real CLI as the paired machine, named devbox. */
  machine: (name: string, args: string[]) => ReturnType<typeof cli>;
  /**
   * Claude Code's PermissionRequest hook on the machine, given `input` on stdin as Claude Code
   * gives it; resolves to what it prints once answered.
   */
  prompt: (input: object) => Promise<string>;
  /** Screenshots of the page's current state; returns their paths. */
  shot: (name: string) => Promise<string[]>;
  services: Awaited<ReturnType<typeof boot>>["services"];
  step: typeof step;
};

const SIZES = [
  ["phone", { width: 360, height: 780 }],
  ["tablet", { width: 768, height: 1024 }],
  ["desktop", { width: 1280, height: 860 }],
] as const;

const [scenarioArg, outArg] = process.argv.slice(2);
if (!scenarioArg || !outArg) {
  console.error("usage: xvfb-run -a node web/e2e/drive.ts <scenario.ts> <out dir>");
  process.exit(64);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const scenario = (await import(resolve(scenarioArg))).default as (s: Scenario) => Promise<void>;

let page: Page | undefined;
const ff = await browser();
try {
  step("services, server, web");
  const { services } = await boot();
  const context = await ff.newContext({ permissions: ["notifications"] });
  page = await context.newPage();
  const p = page;
  p.on("console", (m) => m.type() === "error" && console.log(`[page] ${m.text()}`));
  await p.setViewportSize(SIZES[2][1]);

  step("sign in with GitHub (stub) and set up the first device");
  await p.goto(ORIGIN);
  await p.getByRole("link", { name: /^(Sign in|Continue) with GitHub$/ }).click();
  await p.getByLabel(/I stored this key/).check();
  await p.getByRole("button", { name: "Create the account" }).click();
  await p.getByRole("heading", { name: "Inbox" }).waitFor();

  step("pair a machine named devbox");
  const home = join(tmp, "machine");
  const pair = cli("pair", ["pair", "--name", "devbox"], home);
  const code = (await pair.waitFor(/Pairing code: (\S+)/))[1] as string;
  await p.getByRole("link", { name: "Type a code instead" }).click();
  await p.getByLabel("Pair a machine or device").fill(code);
  await p.getByRole("button", { name: "Check code" }).click();
  await p.getByRole("button", { name: "Approve" }).click();
  await pair.waitFor(/Check code: (\S+)/);
  if ((await cli("pair-confirm", ["pair", "--confirm"], home).exited) !== 0)
    throw new Error("pair --confirm failed");
  if ((await pair.exited) !== 0) throw new Error("pair failed");
  await p.goto(ORIGIN);
  await p.getByText("Nothing needs you").waitFor();

  await scenario({
    page: p,
    context,
    machine: (name, args) => cli(name, args, home),
    prompt(input) {
      const hook = spawn(
        "bun",
        ["run", join(ROOT, "cli/src/main.ts"), "hook", "permission", "--agent", "claude-code"],
        {
          env: {
            ...machineEnv(),
            STARBRIDGE_CONFIG_DIR: home,
            STARBRIDGE_SERVER: `http://localhost:${PORTS.server}`,
          },
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
      children.push(hook);
      let printed = "";
      hook.stdout?.on("data", (c: Buffer) => {
        printed += c.toString();
      });
      hook.stdin?.end(JSON.stringify(input));
      return new Promise((done) => hook.on("exit", () => done(printed)));
    },
    services,
    step,
    async shot(name) {
      const paths: string[] = [];
      const at = p.viewportSize() ?? SIZES[2][1];
      for (const [size, viewport] of SIZES)
        for (const scheme of ["light", "dark"] as const) {
          await p.setViewportSize(viewport);
          await p.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
          await p.waitForTimeout(150);
          const path = join(out, `${name}-${size}-${scheme}.png`);
          await p.screenshot({ path, fullPage: viewport.width >= 600 });
          paths.push(path);
        }
      await p.setViewportSize(at);
      await p.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
      return paths;
    },
  });
  console.log("\nSCENARIO PASSED");
} catch (e) {
  console.error("\nSCENARIO FAILED:", e);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await ff.close().catch(() => {});
  shutdown();
  process.exit();
}
