import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { LiveServer } from "@starbridge/server/test-support";
import { proof, socketPath } from "../src/agent/api";
import { run } from "../src/cli";
import { Store } from "../src/config";
import type { Ctx } from "../src/context";
import { sendConfirm } from "../src/pair";
import { normalEnv, which } from "../src/platform";

const WINDOWS = process.platform === "win32";
const FIXTURES = join(import.meta.dir, "fixtures");

/**
 * Git for Windows' sh, which runs the shell-script fakes there. Its `bin\sh.exe` puts Git's own
 * tools on the PATH, unlike `usr\bin\sh.exe`; `System32\bash.exe` is WSL's.
 */
function gitSh(): string {
  const git = which(normalEnv(process.env), "git");
  const sh = [
    ...(git ? [join(dirname(git), "..", "bin", "sh.exe")] : []),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe"),
  ].find((p) => existsSync(p));
  if (!sh) throw new Error("the tests' shell-script fakes need Git for Windows' sh");
  return sh;
}

/** The sh that runs the plugin's hooks: Git for Windows' on Windows, as Claude Code's there. */
export const sh = () => (WINDOWS ? gitSh() : "/bin/sh");

/** Only `env`, plus on Windows the SystemRoot that every process there needs to start. */
export const bareEnv = (env: Record<string, string>): Record<string, string> =>
  WINDOWS ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", ...env } : env;

/** `path` with forward slashes, which sh and Node both take on Windows. */
export const slashes = (path: string) => path.replace(/\\/g, "/");

/** The folders a fake's PATH ends with: the system's own tools (`tar`, `icacls`). */
export const SYSTEM_PATH = WINDOWS
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  : ["/usr/bin", "/bin"].join(delimiter);

/**
 * Writes a shell script at `path` and returns the command that runs it. Windows starts no file
 * by its `#!` line, so there it also writes `path.cmd`, which starts the script with Git's sh and
 * which the CLI finds on the PATH as `path`'s name; the `.cmd` is returned.
 */
export function fakeCommand(path: string, script: string): string {
  writeFileSync(path, script, { mode: 0o755 });
  return WINDOWS ? shim(path, dirname(path)) : path;
}

/** A `.cmd` in `dir` named as `script`, without its `.sh`, that runs it with Git's sh. */
function shim(script: string, dir: string): string {
  const cmd = join(dir, `${basename(script).replace(/\.sh$/, "")}.cmd`);
  writeFileSync(cmd, `@"${gitSh()}" "${slashes(script)}" %*\r\n`);
  return cmd;
}

/** On Windows, a folder of `.cmd` shims for the scripts in `dir`. */
function shimmed(dir: string): string {
  const out = mkdtempSync(join(tmpdir(), "starbridge-shims-"));
  for (const f of readdirSync(dir)) shim(join(dir, f), out);
  return out;
}

/** Stands in for `codexbar usage`, replaying recorded output. */
export const FAKE_CODEXBAR = WINDOWS
  ? shim(join(FIXTURES, "fake-codexbar.sh"), mkdtempSync(join(tmpdir(), "starbridge-shims-")))
  : join(FIXTURES, "fake-codexbar.sh");

/** The folder of fake systemctl, claude, pi and the others, for a PATH. */
export const FAKE_BIN = WINDOWS ? shimmed(join(FIXTURES, "fake-bin")) : join(FIXTURES, "fake-bin");

const builds = new Map<string, string>();
/**
 * `source` built into an executable, for a fake that must be a binary: Windows starts only an
 * `.exe` where the CLI runs one by its path. Built once per source and test file.
 */
export function compiledFake(source: string): string {
  let exe = builds.get(source);
  if (!exe) {
    const dir = mkdtempSync(join(tmpdir(), "starbridge-exe-"));
    const main = join(dir, "main.ts");
    writeFileSync(main, source);
    exe = join(dir, WINDOWS ? "fake.exe" : "fake");
    const r = Bun.spawnSync([process.execPath, "build", main, "--compile", "--outfile", exe]);
    if (r.exitCode !== 0) throw new Error(`could not build a fake: ${r.stderr.toString()}`);
    builds.set(source, exe);
  }
  return exe;
}

/** Where an agent for the config folder `dir` listens: a port file on Windows, else a socket. */
export const agentAddress = (dir: string) => socketPath({}, dir);

/**
 * Has `fake` listen where an agent for `address` would: on its unix socket, or on loopback TCP
 * named by a port file, answering each call with the proof a real agent gives.
 */
export async function listenAt(fake: Server, address: string) {
  if (!address.endsWith(".port")) return new Promise<void>((r) => fake.listen(address, r));
  const token = "t".repeat(32);
  fake.prependListener("request", (req, res) => {
    const nonce = req.headers["starbridge-nonce"];
    if (typeof nonce === "string") res.setHeader("starbridge-proof", proof(token, "agent", nonce));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const { port } = fake.address() as AddressInfo;
  writeFileSync(address, JSON.stringify({ port, token, pid: process.pid }));
}

export interface TestCtx extends Ctx {
  lines: string[];
  errors: string[];
}

export function testCtx(env: Record<string, string> = {}): TestCtx {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    env,
    store: new Store(mkdtempSync(join(tmpdir(), "starbridge-cli-"))),
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    lines,
    errors,
  };
}

export async function until(pred: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** Runs `starbridge pair` and approves it from the owner's phone. */
export async function paired(server: LiveServer, name = "devbox"): Promise<TestCtx> {
  const ctx = testCtx();
  const done = run(["pair", "--server", server.url, "--name", name], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: "))).catch((e) => {
    throw new Error(`pair printed no code: ${[...ctx.lines, ...ctx.errors].join("\n")}`, {
      cause: e,
    });
  });
  await approveAndConfirm(server, ctx);
  if ((await done) !== 0) throw new Error(ctx.errors.join("\n"));
  ctx.lines.length = 0;
  return ctx;
}

/**
 * Approves, as the owner's phone, the pairing whose code `ctx` printed, from the typed code, then
 * answers whether the check codes match, as `starbridge pair --confirm` or `--reject` does.
 * Returns the check code the phone shows.
 */
export async function approveAndConfirm(server: LiveServer, ctx: TestCtx, same = true) {
  await until(() => ctx.lines.some((l) => l.startsWith("Pairing code: ")));
  const code = ctx.lines.findLast((l) => l.startsWith("Pairing code: "))?.slice(14) as string;
  const check = await server.approve(code);
  await until(() => ctx.lines.some((l) => l.includes("Same code?")));
  sendConfirm({ ...ctx, out: () => {} }, same);
  return check;
}
