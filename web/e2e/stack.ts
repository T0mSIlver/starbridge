// The whole product on one machine, for the end-to-end run (run.ts): free ports, the processes it
// starts and their output, the stand-ins for GitHub and the Web Push service (services.ts), the
// server, the built web page, the real CLI and Firefox.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
  opts: { cwd?: string; env?: object; quiet?: boolean } = {},
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
    if (!opts.quiet)
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

/** The real CLI, as a machine whose config lives in `home`, on the server at `server`. */
export function cli(
  name: string,
  args: string[],
  home: string,
  opts: { server?: string; quiet?: boolean } = {},
) {
  return start(name, "bun", ["run", join(ROOT, "cli/src/main.ts"), ...args], {
    env: {
      STARBRIDGE_CONFIG_DIR: home,
      STARBRIDGE_SERVER: opts.server ?? `http://localhost:${PORTS.server}`,
    },
    quiet: opts.quiet,
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

export interface BootOptions {
  /** The origin the server puts in its links: the web page's own, or a proxy in front of it. */
  origin?: string;
  /** The server's port, when it must not change between runs (desktop/test/switch.ts). */
  serverPort?: number;
  /** Gives the server Web Push keys, as the web's run needs; the desktop's runs go without. */
  push?: boolean;
  /** Builds the web page first; false serves the last build when there is one. */
  build?: boolean;
  /** Keeps the processes' output off the console. */
  quiet?: boolean;
}

/** The web page built against `server`, laid out as web/Dockerfile copies it. */
export function buildWeb(server: string, quiet = false) {
  if (
    spawnSync("bun", ["run", "build"], {
      cwd: WEB,
      env: { ...process.env, STARBRIDGE_SERVER: server },
      stdio: quiet ? "ignore" : "inherit",
    }).status
  )
    throw new Error("web build failed");
  cpSync(join(WEB, ".next/static"), join(STANDALONE, ".next/static"), { recursive: true });
  cpSync(join(WEB, "public"), join(STANDALONE, "public"), { recursive: true });
}

const STANDALONE = join(WEB, ".next/standalone/web");

/** Serves the built web page on `PORTS.web`, sending `/v1` to `server`. */
export async function serveWeb(server: string, quiet = false) {
  await free(PORTS.web);
  const web = start("web", "node", [join(STANDALONE, "server.js")], {
    env: { STARBRIDGE_SERVER: server, PORT: String(PORTS.web), HOSTNAME: "127.0.0.1" },
    quiet,
  });
  await web.waitFor(/Ready|started server/i);
  return web;
}

/**
 * Starts the stand-ins, the server on a fresh database and the built web page: the one setup
 * of the whole product the web's run and the desktop's runs share.
 */
export async function boot(opts: BootOptions = {}) {
  const { quiet } = opts;
  await free(PORTS.github, PORTS.push);
  const services = start("services", "bun", [join(WEB, "e2e/services.ts")], {
    env: { GITHUB_PORT: PORTS.github, PUSH_PORT: PORTS.push },
    quiet,
  });
  await services.waitFor(/"event":"ready"/);
  const port = opts.serverPort ?? PORTS.server;
  if (port === PORTS.server) await free(PORTS.server);
  const server = start("server", "bun", ["run", "server/src/main.ts"], {
    env: {
      PORT: port,
      DB_PATH: join(tmp, "starbridge.db"),
      PUBLIC_URL: opts.origin ?? ORIGIN,
      GITHUB_CLIENT_ID: "stub",
      GITHUB_CLIENT_SECRET: "stub",
      GITHUB_AUTHORIZE_URL: `http://localhost:${PORTS.github}/login/oauth/authorize`,
      GITHUB_TOKEN_URL: `http://localhost:${PORTS.github}/login/oauth/access_token`,
      GITHUB_API_URL: `http://localhost:${PORTS.github}`,
      ...(opts.push === false
        ? {}
        : {
            VAPID_PUBLIC_KEY: vapid.publicKey,
            VAPID_PRIVATE_KEY: vapid.privateKey,
            VAPID_SUBJECT: "mailto:e2e@starbridge.invalid",
            ALLOW_PRIVATE_PUSH_ENDPOINTS: "1",
          }),
    },
    quiet,
  });
  await server.waitFor(/starbridge server on port/);
  const url = `http://localhost:${port}`;
  if (opts.build !== false || !existsSync(join(STANDALONE, "server.js"))) buildWeb(url);
  const web = await serveWeb(url, quiet);
  return { services, server, web, url };
}

/**
 * Plays the owner's browser through a sign-in from `url`: follows each redirect, sending each
 * origin the cookies it set, as a browser does, until a response that is not a redirect or a
 * link a browser hands to an app, such as `starbridge://auth`. Returns where it stopped, the
 * last status and the cookies by origin.
 */
export async function followSignIn(url: string) {
  const jar = new Map<string, Map<string, string>>();
  let at = url;
  let status = 0;
  for (let hops = 0; hops < 20 && /^https?:/.test(at); hops++) {
    const origin = new URL(at).origin;
    const cookies = jar.get(origin) ?? new Map<string, string>();
    jar.set(origin, cookies);
    const res = await fetch(at, {
      redirect: "manual",
      headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    status = res.status;
    for (const c of res.headers.getSetCookie()) {
      const [k = "", ...v] = (c.split(";")[0] ?? "").split("=");
      if (k.trim()) cookies.set(k.trim(), v.join("="));
    }
    const location = res.headers.get("location");
    if (!location) break;
    at = new URL(location, at).toString();
  }
  return { at, status, cookies: jar };
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
