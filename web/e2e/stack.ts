// The whole product on one machine, for the end-to-end run (run.ts): free ports, the processes it
// starts and their output, the stand-ins for GitHub and the Web Push service (services.ts), the
// server, the built web page, the real CLI and Firefox.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { firefox } from "playwright";

export const ROOT = resolve(import.meta.dirname, "../..");
export const WEB = join(ROOT, "web");

/**
 * Ports nothing else listens on, so runs on one machine (CI's runners share one) never collide.
 * They come from below Linux's range for outgoing connections (32768 up), whose closed
 * connections linger and keep a server from taking their port. Each stays held until `free`
 * hands it to its process: the web build takes a minute, time enough to lose it otherwise.
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
const free = (...ports: number[]) =>
  Promise.all(ports.map((p) => new Promise((done) => held.get(p)?.close(done))));
export const PORTS = {
  web: await hold(),
  server: await hold(),
  github: await hold(),
  push: await hold(),
};
export const ORIGIN = `http://localhost:${PORTS.web}`;
export const tmp = mkdtempSync(join(tmpdir(), "starbridge-e2e-"));
export const children: ChildProcess[] = [];

/** The steps run so far, in order: the evidence's list of what was driven. */
export const steps: string[] = [];

export function step(text: string) {
  steps.push(text);
  console.log(`\n== ${text}`);
}

/**
 * This process's environment without the variables an agent session sets: the CLI reads them to
 * name the session a question comes from, so a run started inside one would show its name.
 */
export function machineEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|OPENCODE|CURSOR|PI_)/.test(k)),
  ) as NodeJS.ProcessEnv;
}

/** Starts a process and collects its output; `waitFor` resolves on a matching line. */
export function start(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: object } = {},
) {
  const p = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...machineEnv(), ...opts.env },
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
  const exited = new Promise<number>((r) =>
    p.on("exit", (code, signal) => {
      if (code !== 0 && !p.killed) console.log(`[${name}] exited ${signal ?? code}`);
      r(code ?? -1);
    }),
  );
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

/** The real CLI, as a machine whose config lives in `home`. */
export function cli(name: string, args: string[], home: string) {
  return start(name, "bun", ["run", join(ROOT, "cli/src/main.ts"), ...args], {
    env: { STARBRIDGE_CONFIG_DIR: home, STARBRIDGE_SERVER: `http://localhost:${PORTS.server}` },
  });
}

/** A VAPID key pair: the uncompressed public point and the private scalar, base64url. */
const vapid = (() => {
  const { x, y, d } = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    format: "jwk",
  });
  const point = Buffer.concat([
    Buffer.of(4),
    Buffer.from(x ?? "", "base64url"),
    Buffer.from(y ?? "", "base64url"),
  ]);
  return { publicKey: point.toString("base64url"), privateKey: d ?? "" };
})();

/** Starts the stand-ins, the server on a fresh database and the built web page. */
export async function boot() {
  await free(PORTS.github, PORTS.push);
  const services = start("services", "bun", [join(WEB, "e2e/services.ts")], {
    env: { GITHUB_PORT: PORTS.github, PUSH_PORT: PORTS.push },
  });
  await services.waitFor(/"event":"ready"/);
  await free(PORTS.server);
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
  await free(PORTS.web);
  const web = start("web", "node", [join(standalone, "server.js")], {
    env: { ...env, PORT: String(PORTS.web), HOSTNAME: "127.0.0.1" },
  });
  await web.waitFor(/Ready|started server/i);
  return { services, server, web };
}

export async function browser() {
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
      // Firefox queues past a few notifications that stay up until dismissed, and their
      // showNotification never settles; the run leaves many up across its browsers.
      "dom.webnotifications.requireinteraction.count": 100,
    },
  });
}

/** Stops every process the run started and deletes its files. */
export function shutdown() {
  for (const p of children) p.kill();
  for (const s of held.values()) s.close();
  rmSync(tmp, { recursive: true, force: true });
}
